#define _CRT_SECURE_NO_WARNINGS 1
#define QUIC_API_ENABLE_PREVIEW_FEATURES 1

#ifdef _WIN32
#include <share.h>
#endif
#include "msquic.h"

#include "xxhash.c"
#undef WIN32
#define WIN32 1
#pragma warning(push)
#pragma warning(disable: 4200)
#pragma warning(disable: 4334)
#include "lsqpack.c"
#pragma warning(pop)


#include <stdio.h>
#include <stdlib.h>
#include "jc.c"

typedef int32_t h3_err_kind;
enum {
 H3ErrNoError = 0x0100,
 H3ErrGeneralProtocolError= 0x0101,
 H3ErrInternalError = 0x0102,
 H3ErrStreamCreationError= 0x0103,
 H3ErrClosedCriticalStream = 0x0104,
 H3ErrFrameUnexpected = 0x0105,
 H3ErrFrameError = 0x0106,
 H3ErrExcessiveLoad = 0x0107,
 H3ErrIdError = 0x0108,
 H3ErrSettingsError = 0x0109,
 H3ErrMissingSettings = 0x010a,
 H3ErrRequestRejected = 0x010b,
 H3ErrRequestCancelleD = 0x010c,
 H3ErrRequestIncomplete = 0x010d,
 H3ErrMessageError = 0x010e,
 H3ErrConnectError = 0x010f,
 H3ErrVersionFallback = 0x0110,
};

// 64bit plays nice with varint parsing
typedef uint64_t h3_stream_kind;
enum {
 H3StreamControl = 0x00,
 H3StreamPush = 0x01,
 H3StreamQpackEncoder = 0x02,
 H3StreamQpackDecoder = 0x03,
 H3StreamUniWebtransportStream = 0x54,
};

typedef uint64_t h3_frame_kind;
enum {
 H3FrameData = 0x00,
 H3FrameHeaders = 0x01,
 H3FrameCancelPush = 0x03,
 H3FrameSettings = 0x04,
 H3FramePushPromise = 0x05,
 H3FrameGoaway = 0x07,
 H3FrameMaxPushId = 0x0d,
 H3FrameBidirWebtransportStream = 0x41,
};

typedef uint64_t h3_setting_kind;
enum {
 H3SettingQpackMaxTableCapacity = 0x01,
 H3SettingMaxFieldSectionSize = 0x06,
 H3SettingQpackBlockedStreams = 0x07,
 H3SettingEnableConnectProtocol = 0x08,
 H3SettingH3Datagram = 0x33,
 H3SettingH3Draft04Datagram = 0xffd277,
 H3SettingEnableWebtransport = 0x2b603742,
 H3SettingWebtransportMaxSessions = 0x2b603743
};

typedef struct h3_settings h3_settings;
struct h3_settings {
 uint32_t MaxFieldSectionSize;
 uint32_t QpackMaxTableLn;
 uint32_t QpackBlockedStreams;
 uint32_t WtMaxSessions;

 uint32_t DatagramOn;
 uint32_t ConnectProtocolOn;
 uint32_t WebtransportOn;

 uint32_t Sent;
 uint32_t Recvd;
};

#define WtStreamIsUni(Id) ((Id) & 0x02)
#define WtStreamIsClientInitiated(Id) (!((Id) & 0x01))

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
 h3_settings PeerSettings;
 HQUIC ControlStream;

 // a8_sll_node *FreePacket;

 wt_server *Srv;
 wt_con *Next;
 wt_stream *First;
 wt_stream *FreeStream;
};

struct wt_stream
{
 uint64_t Id;
 h3_stream_kind Type;

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

static uint32_t
A8EatVarInt(a8 *A, uint64_t *Out)
{
 if (A->Ln)
 {
  uint64_t V = (uint8_t)A->Mem[0];
  uint8_t Prefix = (uint8_t)V >> 6;
  uint8_t Ln = 1 << Prefix;
  V = V & 0x3f;
  if (Ln <= A->Ln)
  {
   for (int8_t I = 1; I < Ln; ++I)
   {
    V = (V << 8) + A->Mem[I];
   }
   *Out = V;
   A8ShlMut(A, Ln ? Ln : 1);
   return 1;
  }
  return 0;
 }
 return 0;
}

static uint32_t
A8WriteVarInt(a8 *A, uint64_t N)
{
 if (N < 0x40 && A->Ln >= 1)
 {
  *A->Mem = (uint8_t)N;
  A8ShlMut(A, 1);
  return 1;
 }
 else if (N < 0x4000 && A->Ln >= 2)
 {
  *(uint16_t *)A->Mem = BswapU16((uint16_t)N | 0x4000);
  A8ShlMut(A, 2);
  return 1;
 }
 else if (N < 0x40000000 && A->Ln >= 4)
 {
  *(uint32_t *)A->Mem = BswapU32((uint32_t)N | (0x80 << 24));
  A8ShlMut(A, 4);
  return 1;
 }
 else if (A->Ln >= 8)
 {
  *(uint64_t *)A->Mem = BswapU64(N | (0xC0ull << 56));
  A8ShlMut(A, 8);
  return 1;
 }
 return 0;
}

static uint32_t
A8WriteA8(a8 *Dst, a8 Src)
{
 if (Dst->Ln >= Src.Ln)
 {
  memcpy(Dst->Mem, Src.Mem, Src.Ln);
  A8ShlMut(Dst, Src.Ln);
  return 1;
 }
 return 0;
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

static void
StreamSendShutdown(QUIC_API_TABLE *MsQuic, HQUIC Stream, int32_t StatusCode)
{
 MsQuic->StreamShutdown(Stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT_SEND | QUIC_STREAM_SHUTDOWN_FLAG_ABORT_RECEIVE, StatusCode);
}

static void
ConnectionShutdown(QUIC_API_TABLE *MsQuic, HQUIC Con, int32_t StatusCode)
{
 MsQuic->ConnectionShutdown(Con, QUIC_CONNECTION_SHUTDOWN_FLAG_NONE, StatusCode);
}

static uint32_t
A8EatSettingsBody(a8 *A, h3_settings *Out)
{
 while (A->Ln)
 {
  uint64_t SettingType = 0;
  uint64_t SettingVal = 0;
  if (A8EatVarInt(A, &SettingType) && A8EatVarInt(A, &SettingVal))
  {
   switch (SettingType)
   {
    case H3SettingQpackMaxTableCapacity:
    {
     Out->QpackMaxTableLn = (uint32_t)SettingVal;
    } break;
    case H3SettingMaxFieldSectionSize:
    {
     Out->MaxFieldSectionSize = (uint32_t)SettingVal;
    } break;
    case H3SettingQpackBlockedStreams:
    {
     Out->QpackBlockedStreams = (uint32_t)SettingVal;
    } break;
    case H3SettingEnableConnectProtocol:
    {
     Out->ConnectProtocolOn = (uint32_t)SettingVal;
    } break;
    case H3SettingH3Datagram:
    {
     Out->DatagramOn = (uint32_t)SettingVal;
    } break;
    case H3SettingH3Draft04Datagram:
    {
     Out->DatagramOn = (uint32_t)SettingVal;
    } break;
    case H3SettingEnableWebtransport:
    {
     Out->WebtransportOn = (uint32_t)SettingVal;
    } break;
    case H3SettingWebtransportMaxSessions:
    {
     Out->WtMaxSessions = (uint32_t)SettingVal;
    } break;
    default:
    {
     continue;
    }
   }
  }
  else
  {
   return 0;
  }
 }
 return 1;
}

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
  // todo Free that send data
  // free(Event->SEND_COMPLETE.ClientContext);
  printf("[strm][%p] Data sent\n", QStream);
  break;
 }
 // todo
 case QUIC_STREAM_EVENT_RECEIVE:
 {
  printf("[strm][%p] Data received\n", QStream);
  
  uint32_t ShouldEatStreamType = 0;
  if (Stream->Id == UINT64_MAX)
  {
   ShouldEatStreamType = 1;
   uint32_t StreamIdSize = sizeof(Stream->Id);
   if (QUIC_FAILED(MsQuic->GetParam(QStream, QUIC_PARAM_STREAM_ID, &StreamIdSize, &Stream->Id)))
   {
    StreamSendShutdown(MsQuic, QStream, H3ErrInternalError);
    return QUIC_STATUS_SUCCESS;
   }
  }

  for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
  {
   QUIC_BUFFER Buf = Event->RECEIVE.Buffers[I];
   a8 View = A8(Buf.Buffer, Buf.Length);
   if (WtStreamIsUni(Stream->Id))
   {
    if (ShouldEatStreamType && !A8EatVarInt(&View, &Stream->Type))
    {
     StreamSendShutdown(MsQuic, QStream, H3ErrInternalError);
     return QUIC_STATUS_SUCCESS;
    }
    ShouldEatStreamType = 0;
    printf("Recv msg for stream type: %zd\n", Stream->Type);

    if (Stream->Type == H3StreamControl)
    {
     while (View.Ln)
     {
      // frame
      uint64_t FrameType = 0;
      uint64_t FrameLn = 0;
      if (!(A8EatVarInt(&View, &FrameType) && A8EatVarInt(&View, &FrameLn)))
      {
       StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
       return QUIC_STATUS_SUCCESS;
      }

      switch (FrameType)
      {
       case H3FrameSettings:
       {
        if (Stream->Con->PeerSettings.Recvd)
        {
         StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
         return QUIC_STATUS_SUCCESS;
        }

        a8 SettingsView = A8(View.Mem, FrameLn);
        if (A8EatSettingsBody(&SettingsView, &Stream->Con->PeerSettings))
        {
         A8ShlMut(&View, FrameLn);
         Stream->Con->PeerSettings.Recvd = 1;
         // todo validate recvd settings
         // todo send settings

         h3_settings LocalSettings = {
          .MaxFieldSectionSize = 65536,
          .QpackMaxTableLn = 4096,
          .QpackBlockedStreams = 100,
          .WtMaxSessions = 16,
          .DatagramOn = 1,
          .ConnectProtocolOn = 1,
          .WebtransportOn = 1,
         };

         // todo leak for now
         QUIC_BUFFER *SendBuf = ArPush(Stream->Con->Srv->Ar, QUIC_BUFFER, 1);
         a8 A = ArPushA8(Stream->Con->Srv->Ar, 256);
         a8 AView = A;

         char TmpArr[256] = {0};
         a8 TmpSettings = A8(TmpArr, sizeof(TmpArr));
         a8 TmpSettingsView = TmpSettings;

         A8WriteVarInt(&TmpSettingsView, H3SettingMaxFieldSectionSize);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.MaxFieldSectionSize);
         A8WriteVarInt(&TmpSettingsView, H3SettingQpackMaxTableCapacity);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.QpackMaxTableLn);
         A8WriteVarInt(&TmpSettingsView, H3SettingQpackBlockedStreams);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.QpackBlockedStreams);
         A8WriteVarInt(&TmpSettingsView, H3SettingWebtransportMaxSessions);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.WtMaxSessions);
         A8WriteVarInt(&TmpSettingsView, H3SettingH3Datagram);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.DatagramOn);
         A8WriteVarInt(&TmpSettingsView, H3SettingEnableConnectProtocol);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.ConnectProtocolOn);
         A8WriteVarInt(&TmpSettingsView, H3SettingEnableWebtransport);
         A8WriteVarInt(&TmpSettingsView, LocalSettings.WebtransportOn);

         a8 FinalTmpSettings = A8(TmpSettings.Mem, TmpSettings.Ln - TmpSettingsView.Ln);
         
         A8WriteVarInt(&AView, H3StreamControl);
         A8WriteVarInt(&AView, H3FrameSettings);
         A8WriteVarInt(&AView, FinalTmpSettings.Ln);
         A8WriteA8(&AView, FinalTmpSettings);

         SendBuf->Buffer = A.Mem;
         SendBuf->Length = (uint32_t)(A.Ln - AView.Ln);

         // todo send correct ctx (Buf)
         printf("Sending settings\n");
         if (QUIC_FAILED(MsQuic->StreamSend(Stream->Con->ControlStream, SendBuf, 1, QUIC_SEND_FLAG_NONE, SendBuf)))
         {
          // todo I think all this should be conshutdown
          StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
          return QUIC_STATUS_SUCCESS;
         }

         // Success
         continue;
        }
        else
        {
         StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
         return QUIC_STATUS_SUCCESS;
        }
       } break;
       case H3FrameGoaway:
       {
        if (!Stream->Con->PeerSettings.Recvd)
        {
         StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
         return QUIC_STATUS_SUCCESS;
        }
        StreamSendShutdown(MsQuic, QStream, H3ErrNoError);
       }
       default:
       {
        if (!Stream->Con->PeerSettings.Recvd)
        {
         StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
         return QUIC_STATUS_SUCCESS;
        }
        // todo more validation, ok ignore unknown frames, but err on unallowed
        continue;
       } break;
      }
     }
    }
   }
   else
   {
    printf("Bidi stream\n");
   }
  }

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

static wt_stream *
ConPushStream(size_t Id, wt_con *Con)
{
 wt_stream *Stream = ArPush(Con->Srv->Ar, wt_stream, 1);
 Stream->Id = Id;
 Stream->Con = Con;
 SLLStackPush(Con->First, Stream);
 return Stream;
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

  wt_stream *Stream = ConPushStream(0, Con);
  if (QUIC_FAILED(MsQuic->StreamOpen(Connection, QUIC_STREAM_OPEN_FLAG_UNIDIRECTIONAL, ServerStreamCallback, Stream, &Con->ControlStream)))
  {
   // todo change to dllstack or something, proper stream dealloc
   SLLStackPop(Con->First);
   SLLStackPush(Con->FreeStream, Stream);
   ConnectionShutdown(MsQuic, Connection, H3ErrInternalError);
   return QUIC_STATUS_SUCCESS;
  }
  if (QUIC_FAILED(MsQuic->StreamStart(Con->ControlStream, QUIC_STREAM_START_FLAG_NONE)))
  {
   SLLStackPop(Con->First);
   SLLStackPush(Con->FreeStream, Stream);
   MsQuic->StreamClose(Con->ControlStream);
   ConnectionShutdown(MsQuic, Connection, H3ErrInternalError);
   return QUIC_STATUS_SUCCESS;
  }

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

  wt_stream *Stream = ConPushStream(UINT64_MAX, Con);
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