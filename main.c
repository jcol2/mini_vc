#define _CRT_SECURE_NO_WARNINGS 1
#define QUIC_API_ENABLE_PREVIEW_FEATURES 1

#ifdef _WIN32
#include <share.h>
#endif
#include "msquic.h"
#include <stdio.h>
#include <stdlib.h>
#include "jc.c"

typedef struct wt_server wt_server;
typedef struct wt_con wt_con;
typedef struct wt_stream wt_stream;

struct wt_server
{
 ar *Ar;
 QUIC_API_TABLE *MsQuic;
 HQUIC Registration;
 HQUIC Configuration;

 wt_con *First;
 wt_con *Free;
};

struct wt_con
{
 wt_server *Srv;
 
 wt_con *Next;

 wt_stream *First;
 wt_stream *Free;
};

struct wt_stream
{
 wt_con *Con;

 wt_stream *Next;
};

uint8_t
DecodeHexChar(char c)
{
 if (c >= '0' && c <= '9') return c - '0';
 if (c >= 'A' && c <= 'F') return 10 + c - 'A';
 if (c >= 'a' && c <= 'f') return 10 + c - 'a';
 return 0;
}

static uint32_t
DecodeHexBuffer(char *HexBuffer, uint32_t OutBufferLen, uint8_t *OutBuffer)
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

// // The length of buffer sent over the streams in the protocol.
// uint32_t SendBufferLength = 100;
// static void
// ServerSend(HQUIC Stream)
// {
//  //
//  // Allocates and builds the buffer to send over the stream.
//  //
//  void* SendBufferRaw = malloc(sizeof(QUIC_BUFFER) + SendBufferLength);
//  if (SendBufferRaw == NULL) {
//      printf("SendBuffer allocation failed!\n");
//      MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
//      return;
//  }
//  QUIC_BUFFER* SendBuffer = (QUIC_BUFFER*)SendBufferRaw;
//  SendBuffer->Buffer = (uint8_t*)SendBufferRaw + sizeof(QUIC_BUFFER);
//  SendBuffer->Length = SendBufferLength;

//  printf("[strm][%p] Sending data...\n", Stream);

//  //
//  // Sends the buffer over the stream. Note the FIN flag is passed along with
//  // the buffer. This indicates this is the last buffer on the stream and the
//  // the stream is shut down (in the send direction) immediately after.
//  //
//  QUIC_STATUS Status;
//  if (QUIC_FAILED(Status = MsQuic->StreamSend(Stream, SendBuffer, 1, QUIC_SEND_FLAG_FIN, SendBuffer))) {
//      printf("StreamSend failed, 0x%x!\n", Status);
//      free(SendBufferRaw);
//      MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
//  }
// }

static QUIC_STATUS
ServerStreamCallback(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;

 switch (Event->Type) {
 case QUIC_STREAM_EVENT_SEND_COMPLETE:
 {
  // A previous StreamSend call has completed, and the context is being
  // returned back to the app.
  free(Event->SEND_COMPLETE.ClientContext);
  printf("[strm][%p] Data sent\n", QStream);
  break;
 }
 // todo
 case QUIC_STREAM_EVENT_RECEIVE:
 {
  printf("[strm][%p] Data received\n", QStream);
  break;
 }
 case QUIC_STREAM_EVENT_PEER_SEND_SHUTDOWN:
 {
  // The peer gracefully shut down its send direction of the stream.
  printf("[strm][%p] Peer shut down\n", QStream);
  // ServerSend(Stream);
  break;
 }
 case QUIC_STREAM_EVENT_PEER_SEND_ABORTED:
 {
  // The peer aborted its send direction of the stream.
  printf("[strm][%p] Peer aborted\n", QStream);
  MsQuic->StreamShutdown(QStream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
  break;
 }
 case QUIC_STREAM_EVENT_SHUTDOWN_COMPLETE:
 {
  // Both directions of the stream have been shut down and MsQuic is done
  // with the stream. It can now be safely cleaned up.
  printf("[strm][%p] All done\n", QStream);
  MsQuic->StreamClose(QStream);
  break;
 }
 default:
 {
  break;
 }
 }
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
ServerConnectionCallback(HQUIC Connection, void *Ctx, QUIC_CONNECTION_EVENT *Event)
{
 wt_con *Con = (wt_con *)Ctx;
 QUIC_API_TABLE *MsQuic = Con->Srv->MsQuic;

 switch (Event->Type)
 {
 case QUIC_CONNECTION_EVENT_CONNECTED:
 {
  // The handshake has completed for the connection.
  printf("[conn][%p] Connected\n", Connection);
  MsQuic->ConnectionSendResumptionTicket(Connection, QUIC_SEND_RESUMPTION_FLAG_NONE, 0, NULL);
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_TRANSPORT:
 {
  // The connection has been shut down by the transport. Generally, this
  // is the expected way for the connection to shut down with this
  // protocol, since we let idle timeout kill the connection.
  if (Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status == QUIC_STATUS_CONNECTION_IDLE)
  {
   printf("[conn][%p] Successfully shut down on idle.\n", Connection);
  }
  else
  {
   printf("[conn][%p] Shut down by transport, 0x%x\n", Connection, Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status);
  }
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_PEER:
 {
  // The connection was explicitly shut down by the peer.
  printf("[conn][%p] Shut down by peer, 0x%llu\n", Connection, (unsigned long long)Event->SHUTDOWN_INITIATED_BY_PEER.ErrorCode);
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE:
 {
  // The connection has completed the shutdown process and is ready to be
  // safely cleaned up.
  printf("[conn][%p] All done\n", Connection);
  MsQuic->ConnectionClose(Connection);
  break;
 }
 // todo
 case QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED:
 {
  printf("[strm][%p] Peer started\n", Event->PEER_STREAM_STARTED.Stream);

  wt_stream *Stream = ArPush(Con->Srv->Ar, wt_stream, 1);
  Stream->Con = Con;
  SLLStackPush(Con->First, Stream);
  MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, (void *)ServerStreamCallback, (void *)Stream);
  break;
 }
 case QUIC_CONNECTION_EVENT_RESUMED:
 {
  // The connection succeeded in doing a TLS resumption of a previous
  // connection's session.
  printf("[conn][%p] Connection resumed!\n", Connection);
  break;
 }
 default:
 {
  break;
 }
 }
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
ServerListenerCallback(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event)
{
 wt_server *Srv = (wt_server *)Ctx;
 QUIC_STATUS Status = QUIC_STATUS_NOT_SUPPORTED;
 switch (Event->Type)
 {
 case QUIC_LISTENER_EVENT_NEW_CONNECTION:
 {
  wt_con *Con = ArPush(Srv->Ar, wt_con, 1);
  Con->Srv = Srv;
  SLLStackPush(Srv->First, Con);
  Srv->MsQuic->SetCallbackHandler(Event->NEW_CONNECTION.Connection, (void *)ServerConnectionCallback, (void *)Con);
  Status = Srv->MsQuic->ConnectionSetConfiguration(Event->NEW_CONNECTION.Connection, Srv->Configuration);
  break;
 }
 case QUIC_LISTENER_EVENT_STOP_COMPLETE:
 {
  Status = QUIC_STATUS_SUCCESS;
  printf("QUIC_LISTENER_EVENT_STOP_COMPLETE\n");
  break;
 }
 default:
 {
  break;
 }
 }
 return Status;
}

int
main(int argc, char* argv[])
{
 ar *Ar = ArAlloc();
 wt_server *Srv = ArPush(Ar, wt_server, 1);
 Srv->Ar = Ar;

 uint16_t UdpPort = 4567;
 QUIC_STATUS Status = QUIC_STATUS_SUCCESS;
 if (QUIC_FAILED(Status = MsQuicOpen2(&Srv->MsQuic))) {
  printf("MsQuicOpen2 failed, 0x%x!\n", Status);
 }

 const QUIC_REGISTRATION_CONFIG RegConfig = { "quicsample", QUIC_EXECUTION_PROFILE_LOW_LATENCY };
 if (QUIC_FAILED(Status = Srv->MsQuic->RegistrationOpen(&RegConfig, &Srv->Registration))) {
  printf("RegistrationOpen failed, 0x%x!\n", Status);
 }

 if (Srv->MsQuic && Srv->Registration)
 {
  uint64_t IdleTimeoutMs = 1000;
  QUIC_SETTINGS Settings = {0};
  Settings.IdleTimeoutMs = IdleTimeoutMs;
  Settings.IsSet.IdleTimeoutMs = TRUE;
  Settings.HandshakeIdleTimeoutMs = IdleTimeoutMs;
  Settings.IsSet.HandshakeIdleTimeoutMs = TRUE;
  Settings.ServerResumptionLevel = QUIC_SERVER_RESUME_AND_ZERORTT;
  Settings.IsSet.ServerResumptionLevel = TRUE;
  Settings.DatagramReceiveEnabled = TRUE;
  Settings.IsSet.DatagramReceiveEnabled = TRUE;
  Settings.PeerBidiStreamCount = 1000;
  Settings.IsSet.PeerBidiStreamCount = TRUE;
  Settings.PeerUnidiStreamCount = 20;
  Settings.IsSet.PeerUnidiStreamCount = TRUE;

  Settings.StreamRecvWindowDefault = 64 * 1024;
  Settings.IsSet.StreamRecvWindowDefault = TRUE;
  Settings.ConnFlowControlWindow = 1024 * 1024;
  Settings.IsSet.ConnFlowControlWindow = TRUE;

  QUIC_CERTIFICATE_HASH Thumbprint = {0};
  DecodeHexBuffer("4f56656a0f49cd4564f0cad2766ffef89e8e4933", sizeof(Thumbprint.ShaHash), Thumbprint.ShaHash);
  QUIC_CREDENTIAL_CONFIG CredConfig = {0};
  CredConfig.Type = QUIC_CREDENTIAL_TYPE_CERTIFICATE_HASH;
  CredConfig.CertificateHash = &Thumbprint;

  a8 AlpnStr = CStr("h3");
  QUIC_BUFFER Alpn = { (uint32_t)AlpnStr.Ln, (uint8_t*)AlpnStr.Mem };
  if (QUIC_FAILED(Status = Srv->MsQuic->ConfigurationOpen(Srv->Registration, &Alpn, 1, &Settings, sizeof(Settings), NULL, &Srv->Configuration)))
  {
   printf("ConfigurationOpen failed, 0x%x!\n", Status);
  }

  if (QUIC_FAILED(Status = Srv->MsQuic->ConfigurationLoadCredential(Srv->Configuration, &CredConfig)))
  {
   printf("ConfigurationLoadCredential failed, 0x%x!\n", Status);
  }

  HQUIC Listener = 0;
  QUIC_ADDR Address = {0};
  QuicAddrSetFamily(&Address, QUIC_ADDRESS_FAMILY_UNSPEC);
  QuicAddrSetPort(&Address, UdpPort);
  if (QUIC_FAILED(Status = Srv->MsQuic->ListenerOpen(Srv->Registration, ServerListenerCallback, Srv, &Listener)))
  {
   printf("ListenerOpen failed, 0x%x!\n", Status);
  }

  if (QUIC_FAILED(Status = Srv->MsQuic->ListenerStart(Listener, &Alpn, 1, &Address)))
  {
   printf("ListenerStart failed, 0x%x!\n", Status);
  }

  printf("Press Enter to exit.\n\n");
  (void)getchar();

  if (Listener)
  {
   Srv->MsQuic->ListenerClose(Listener);
  }
 }

 if (Srv->MsQuic) {
  if (Srv->Configuration) {
   Srv->MsQuic->ConfigurationClose(Srv->Configuration);
  }
  if (Srv->Registration) {
   Srv->MsQuic->RegistrationClose(Srv->Registration);
  }
  MsQuicClose(Srv->MsQuic);
 }

 return (int)Status;
}