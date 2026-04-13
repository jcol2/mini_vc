#define _CRT_SECURE_NO_WARNINGS 1
#define QUIC_API_ENABLE_PREVIEW_FEATURES 1

#ifdef _WIN32
#include <share.h>
#endif
#include "msquic.h"
#include <stdio.h>
#include <stdlib.h>
#include "jc.c"

// The (optional) registration configuration for the app. This sets a name for
// the app (used for persistent storage and for debugging). It also configures
// the execution profile, using the default "low latency" profile.
const QUIC_REGISTRATION_CONFIG RegConfig = { "quicsample", QUIC_EXECUTION_PROFILE_LOW_LATENCY };


const uint16_t UdpPort = 4567;

// The default idle timeout period (1 second) used for the protocol.
const uint64_t IdleTimeoutMs = 1000;

// The length of buffer sent over the streams in the protocol.
const uint32_t SendBufferLength = 100;

QUIC_API_TABLE* MsQuic = 0;
HQUIC Registration = 0;
HQUIC Configuration = 0;

// The struct to be filled with TLS secrets
// for debugging packet captured with e.g. Wireshark.
QUIC_TLS_SECRETS ClientSecrets = {0};

// The name of the environment variable being
// used to get the path to the ssl key log file.
const char* SslKeyLogEnvVar = "SSLKEYLOGFILE";

uint8_t
DecodeHexChar(char c)
{
 if (c >= '0' && c <= '9') return c - '0';
 if (c >= 'A' && c <= 'F') return 10 + c - 'A';
 if (c >= 'a' && c <= 'f') return 10 + c - 'a';
 return 0;
}

static uint32_t
DecodeHexBuffer(char* HexBuffer, uint32_t OutBufferLen, uint8_t* OutBuffer)
{
 uint32_t HexBufferLen = (uint32_t)strlen(HexBuffer) / 2;
 if (HexBufferLen > OutBufferLen) {
  return 0;
 }

 for (uint32_t i = 0; i < HexBufferLen; i++) {
  OutBuffer[i] = (DecodeHexChar(HexBuffer[i * 2]) << 4) | DecodeHexChar(HexBuffer[i * 2 + 1]);
 }
 return HexBufferLen;
}

void
ServerSend(
    _In_ HQUIC Stream
    )
{
    //
    // Allocates and builds the buffer to send over the stream.
    //
    void* SendBufferRaw = malloc(sizeof(QUIC_BUFFER) + SendBufferLength);
    if (SendBufferRaw == NULL) {
        printf("SendBuffer allocation failed!\n");
        MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
        return;
    }
    QUIC_BUFFER* SendBuffer = (QUIC_BUFFER*)SendBufferRaw;
    SendBuffer->Buffer = (uint8_t*)SendBufferRaw + sizeof(QUIC_BUFFER);
    SendBuffer->Length = SendBufferLength;

    printf("[strm][%p] Sending data...\n", Stream);

    //
    // Sends the buffer over the stream. Note the FIN flag is passed along with
    // the buffer. This indicates this is the last buffer on the stream and the
    // the stream is shut down (in the send direction) immediately after.
    //
    QUIC_STATUS Status;
    if (QUIC_FAILED(Status = MsQuic->StreamSend(Stream, SendBuffer, 1, QUIC_SEND_FLAG_FIN, SendBuffer))) {
        printf("StreamSend failed, 0x%x!\n", Status);
        free(SendBufferRaw);
        MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
    }
}

_IRQL_requires_max_(DISPATCH_LEVEL)
_Function_class_(QUIC_STREAM_CALLBACK)
QUIC_STATUS
QUIC_API
ServerStreamCallback(
    _In_ HQUIC Stream,
    _In_opt_ void* Context,
    _Inout_ QUIC_STREAM_EVENT* Event
    )
{
    UNREFERENCED_PARAMETER(Context);
    switch (Event->Type) {
    case QUIC_STREAM_EVENT_SEND_COMPLETE:
        //
        // A previous StreamSend call has completed, and the context is being
        // returned back to the app.
        //
        free(Event->SEND_COMPLETE.ClientContext);
        printf("[strm][%p] Data sent\n", Stream);
        break;
    case QUIC_STREAM_EVENT_RECEIVE:
        //
        // Data was received from the peer on the stream.
        //
        printf("[strm][%p] Data received\n", Stream);
        break;
    case QUIC_STREAM_EVENT_PEER_SEND_SHUTDOWN:
        //
        // The peer gracefully shut down its send direction of the stream.
        //
        printf("[strm][%p] Peer shut down\n", Stream);
        ServerSend(Stream);
        break;
    case QUIC_STREAM_EVENT_PEER_SEND_ABORTED:
        //
        // The peer aborted its send direction of the stream.
        //
        printf("[strm][%p] Peer aborted\n", Stream);
        MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
        break;
    case QUIC_STREAM_EVENT_SHUTDOWN_COMPLETE:
        //
        // Both directions of the stream have been shut down and MsQuic is done
        // with the stream. It can now be safely cleaned up.
        //
        printf("[strm][%p] All done\n", Stream);
        MsQuic->StreamClose(Stream);
        break;
    default:
        break;
    }
    return QUIC_STATUS_SUCCESS;
}

_IRQL_requires_max_(DISPATCH_LEVEL)
_Function_class_(QUIC_CONNECTION_CALLBACK)
QUIC_STATUS
QUIC_API
ServerConnectionCallback(
    _In_ HQUIC Connection,
    _In_opt_ void* Context,
    _Inout_ QUIC_CONNECTION_EVENT* Event
    )
{
    UNREFERENCED_PARAMETER(Context);
    switch (Event->Type) {
    case QUIC_CONNECTION_EVENT_CONNECTED:
        //
        // The handshake has completed for the connection.
        //
        printf("[conn][%p] Connected\n", Connection);
        MsQuic->ConnectionSendResumptionTicket(Connection, QUIC_SEND_RESUMPTION_FLAG_NONE, 0, NULL);
        break;
    case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_TRANSPORT:
        //
        // The connection has been shut down by the transport. Generally, this
        // is the expected way for the connection to shut down with this
        // protocol, since we let idle timeout kill the connection.
        //
        if (Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status == QUIC_STATUS_CONNECTION_IDLE) {
            printf("[conn][%p] Successfully shut down on idle.\n", Connection);
        } else {
            printf("[conn][%p] Shut down by transport, 0x%x\n", Connection, Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status);
        }
        break;
    case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_PEER:
        //
        // The connection was explicitly shut down by the peer.
        //
        printf("[conn][%p] Shut down by peer, 0x%llu\n", Connection, (unsigned long long)Event->SHUTDOWN_INITIATED_BY_PEER.ErrorCode);
        break;
    case QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE:
        //
        // The connection has completed the shutdown process and is ready to be
        // safely cleaned up.
        //
        printf("[conn][%p] All done\n", Connection);
        MsQuic->ConnectionClose(Connection);
        break;
    case QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED:
        //
        // The peer has started/created a new stream. The app MUST set the
        // callback handler before returning.
        //
        printf("[strm][%p] Peer started\n", Event->PEER_STREAM_STARTED.Stream);
        MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, (void*)ServerStreamCallback, NULL);
        break;
    case QUIC_CONNECTION_EVENT_RESUMED:
        //
        // The connection succeeded in doing a TLS resumption of a previous
        // connection's session.
        //
        printf("[conn][%p] Connection resumed!\n", Connection);
        break;
    default:
        break;
    }
    return QUIC_STATUS_SUCCESS;
}

_IRQL_requires_max_(PASSIVE_LEVEL)
_Function_class_(QUIC_LISTENER_CALLBACK)
QUIC_STATUS
QUIC_API
ServerListenerCallback(HQUIC Listener, void* Context, QUIC_LISTENER_EVENT* Event)
{
 UNREFERENCED_PARAMETER(Listener);
 UNREFERENCED_PARAMETER(Context);
 QUIC_STATUS Status = QUIC_STATUS_NOT_SUPPORTED;
 switch (Event->Type) {
 case QUIC_LISTENER_EVENT_NEW_CONNECTION:
     // A new connection is being attempted by a client. For the handshake to
     // proceed, the server must provide a configuration for QUIC to use. The
     // app MUST set the callback handler before returning.
     MsQuic->SetCallbackHandler(Event->NEW_CONNECTION.Connection, (void*)ServerConnectionCallback, NULL);
     Status = MsQuic->ConnectionSetConfiguration(Event->NEW_CONNECTION.Connection, Configuration);
     break;
 default:
     break;
 }
 return Status;
}

int
main(int argc,  char* argv[])
{
 QUIC_STATUS Status = QUIC_STATUS_SUCCESS;
 if (QUIC_FAILED(Status = MsQuicOpen2(&MsQuic))) {
  printf("MsQuicOpen2 failed, 0x%x!\n", Status);
 }

 if (QUIC_FAILED(Status = MsQuic->RegistrationOpen(&RegConfig, &Registration))) {
  printf("RegistrationOpen failed, 0x%x!\n", Status);
 }

 if (MsQuic && Registration)
 {

  QUIC_SETTINGS Settings = {0};
  Settings.IdleTimeoutMs = IdleTimeoutMs;
  Settings.IsSet.IdleTimeoutMs = TRUE;
  Settings.ServerResumptionLevel = QUIC_SERVER_RESUME_AND_ZERORTT;
  Settings.IsSet.ServerResumptionLevel = TRUE;
  Settings.PeerBidiStreamCount = 1;
  Settings.IsSet.PeerBidiStreamCount = TRUE;

  QUIC_CERTIFICATE_HASH Thumbprint = {0};
  DecodeHexBuffer("9AB69520A0BBFCA8EC5B5CA61DE4182A9008F3DD", sizeof(Thumbprint.ShaHash), Thumbprint.ShaHash);
  QUIC_CREDENTIAL_CONFIG CredConfig = {0};
  CredConfig.Type = QUIC_CREDENTIAL_TYPE_CERTIFICATE_HASH;
  CredConfig.CertificateHash = &Thumbprint;

  const QUIC_BUFFER Alpn = { sizeof("sample") - 1, (uint8_t*)"sample" };
  if (QUIC_FAILED(Status = MsQuic->ConfigurationOpen(Registration, &Alpn, 1, &Settings, sizeof(Settings), NULL, &Configuration))) {
      printf("ConfigurationOpen failed, 0x%x!\n", Status);
      return FALSE;
  }

  if (QUIC_FAILED(Status = MsQuic->ConfigurationLoadCredential(Configuration, &CredConfig))) {
      printf("ConfigurationLoadCredential failed, 0x%x!\n", Status);
      return FALSE;
  }

  HQUIC Listener = 0;

  QUIC_ADDR Address = {0};
  QuicAddrSetFamily(&Address, QUIC_ADDRESS_FAMILY_UNSPEC);
  QuicAddrSetPort(&Address, UdpPort);

  if (QUIC_FAILED(Status = MsQuic->ListenerOpen(Registration, ServerListenerCallback, NULL, &Listener)))
  {
   printf("ListenerOpen failed, 0x%x!\n", Status);
   goto Error;
  }

  if (QUIC_FAILED(Status = MsQuic->ListenerStart(Listener, &Alpn, 1, &Address)))
  {
   printf("ListenerStart failed, 0x%x!\n", Status);
   goto Error;
  }

  printf("Press Enter to exit.\n\n");
  (void)getchar();

Error:
  if (Listener != NULL) {
      MsQuic->ListenerClose(Listener);
  }
 }

 if (MsQuic) {
  if (Configuration) {
   MsQuic->ConfigurationClose(Configuration);
  }
  if (Registration) {
   MsQuic->RegistrationClose(Registration);
  }
  MsQuicClose(MsQuic);
 }

 return (int)Status;
}