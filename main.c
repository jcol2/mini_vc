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
enum
{
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
enum
{
 H3StreamControl = 0x00,
 H3StreamPush = 0x01,
 H3StreamQpackEncoder = 0x02,
 H3StreamQpackDecoder = 0x03,
 // todo maybe add 0x41 bidi signal here
 H3StreamUniWebtransportStream = 0x54,
};

typedef uint64_t h3_frame_kind;
enum
{
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
enum
{
 H3SettingQpackMaxTableCapacity = 0x01,
 H3SettingMaxFieldSectionSize = 0x06,
 H3SettingQpackBlockedStreams = 0x07,
 H3SettingEnableConnectProtocol = 0x08,
 H3SettingH3Datagram = 0x33,
 H3SettingH3Draft04Datagram = 0xffd277,
 H3SettingEnableWebtransport = 0x2b603742,
 H3SettingWebtransportMaxSessions = 0x2b603743,
};

typedef uint64_t wt_capsule_kind;
enum
{
 WtCapsuleDatagram = 0x0,
 WtCapsuleCloseSession = 0x2843,
 WtCapsuleDrainSession = 0x78AE,
 WtCapsuleMaxStreamsBidi = 0x190B4D3F,
 WtCapsuleMaxStreamsUni = 0x190B4D40,
 WtCapsuleStreamsBlockedBidi = 0x190B4D43,
 WtCapsuleStreamsBlockedUni = 0x190B4D44,
 WtCapsuleMaxData = 0x190B4D3D,
 WtCapsuleDataBlocked = 0x190B4D41,
};

typedef struct h3_settings h3_settings;
struct h3_settings
{
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
 HQUIC QCon;

 wt_server *Srv;
 wt_con *Next;
 wt_stream *FirstStream;
 wt_stream *FreeStream;

 char SettingsMsg[64];
 QUIC_BUFFER QBuf;
};

typedef struct varint_decoder varint_decoder;
struct varint_decoder
{
 uint8_t Mem[sizeof(uint64_t)];
 size_t Ln;

 uint64_t Val;
 uint32_t Success;
};

typedef struct varint_pair_decoder varint_pair_decoder;
struct varint_pair_decoder
{
 uint8_t Mem[sizeof(uint64_t) * 2];
 size_t Ln;

 uint64_t Val1;
 uint64_t Val2;
 uint32_t Got1;
 uint32_t Got2;
 uint32_t Success;
};

struct wt_stream
{
 uint64_t Id;
 h3_stream_kind Type;
 uint32_t IsSession;

 varint_pair_decoder CurFrameHeader;
 size_t HeaderFrameOffset;
 varint_pair_decoder CurSetting;

 // todo track if stream closed?

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

// from nibanks/msh3
static inline uint32_t
WtVarIntDecode(uint8_t *Mem, size_t MemLn, size_t *Offset, uint64_t *Value)
{
 if (MemLn < sizeof(uint8_t) + *Offset)
 {
  return 0;
 }
 if (Mem[*Offset] < 0x40)
 {
  *Value = Mem[*Offset];
  *Offset += sizeof(uint8_t);
 }
 else if (Mem[*Offset] < 0x80)
 {
  if (MemLn < sizeof(uint16_t) + *Offset)
  {
   return 0;
  }
  *Value = ((uint64_t)(Mem[*Offset] & 0x3fUL)) << 8;
  *Value |= Mem[*Offset + 1];
  *Offset += sizeof(uint16_t);
 }
 else if (Mem[*Offset] < 0xc0)
 {
  if (MemLn < sizeof(uint32_t) + *Offset)
  {
   return 0;
  }
  uint32_t V;
  memcpy(&V, Mem + *Offset, sizeof(uint32_t));
  *Value = BswapU32(V) & 0x3fffffffUL;
  *Offset += sizeof(uint32_t);
 }
 else
 {
  if (MemLn < sizeof(uint64_t) + *Offset)
  {
   return 0;
  }
  uint64_t V;
  memcpy(&V, Mem + *Offset, sizeof(uint64_t));
  *Value = BswapU64(V) & 0x3fffffffffffffffULL;
  *Offset += sizeof(uint64_t);
 }
 return 1;
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

static uint32_t
H3SettingsInsert(h3_settings *Out, uint64_t SettingType, uint64_t SettingVal)
{
 uint32_t Ret = 1;
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
   Ret = 0;
  }
 }
 return Ret;
}

// todo very tricky, make tests for this
static inline uint32_t
WtVarintDecoderDecode(char *ArrMem, size_t ArrLn, size_t *Offset, varint_decoder *Cache)
{
 if (Cache->Ln)
 {
  Assert(!*Offset); // consumed prev arr, so offset should be 0 in new arr
  size_t ToCopy = Min(sizeof(Cache->Mem) - Cache->Ln, ArrLn);
  memcpy(Cache->Mem + Cache->Ln, ArrMem, ToCopy);
  Cache->Success = WtVarIntDecode(Cache->Mem, Cache->Ln + ToCopy, Offset, &Cache->Val);
  if (Cache->Success)
  {
   *Offset -= Cache->Ln;
   Cache->Ln = 0;
  }
  else
  {
   Cache->Ln += ToCopy;
  }
 }
 else
 {
  Cache->Success = WtVarIntDecode(ArrMem, ArrLn, Offset, &Cache->Val);
  if (!Cache->Success)
  {
   Cache->Ln = ArrLn - *Offset;
   memcpy(Cache->Mem, ArrMem + *Offset, Cache->Ln);
  }
 }
 return Cache->Success;
}

static inline uint32_t
WtVarintPairDecoderDecode(char *ArrMem, size_t ArrLn, size_t *Offset, varint_pair_decoder *Cache)
{
 if (Cache->Ln)
 {
  Assert(*Offset < Cache->Ln);
  size_t ToCopy = Min(sizeof(Cache->Mem) - Cache->Ln, ArrLn);
  memcpy(Cache->Mem + Cache->Ln, ArrMem, ToCopy);
  Cache->Got1 = Cache->Got1 || WtVarIntDecode(Cache->Mem, Cache->Ln + ToCopy, Offset, &Cache->Val1);
  Cache->Got2 = Cache->Got2 || WtVarIntDecode(Cache->Mem, Cache->Ln + ToCopy, Offset, &Cache->Val2);
  Cache->Success = Cache->Got1 && Cache->Got2;
  if (Cache->Success)
  {
   *Offset -= Cache->Ln;
   Cache->Ln = 0;
  }
  else
  {
   Cache->Ln += ToCopy;
  }
 }
 else
 {
  Cache->Got1 = Cache->Got1 || WtVarIntDecode(ArrMem, ArrLn, Offset, &Cache->Val1);
  Cache->Got2 = Cache->Got2 || WtVarIntDecode(ArrMem, ArrLn, Offset, &Cache->Val2);
  Cache->Success = Cache->Got1 && Cache->Got2;
  if (!Cache->Success)
  {
   Cache->Ln = ArrLn - *Offset;
   memcpy(Cache->Mem, ArrMem + *Offset, Cache->Ln);
  }
 }
 return Cache->Success;
}

static QUIC_STATUS
ServerControlStreamCallback(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;

 switch (Event->Type)
 {
 case QUIC_STREAM_EVENT_SEND_COMPLETE:
 {
  // A previous StreamSend call has completed, and the context is being
  // returned back to the app.
  // todo eventually put settings msg in separate alloc?
  // free(Event->SEND_COMPLETE.ClientContext);
  printf("[strm][%p] Data sent\n", QStream);
  break;
 }
 case QUIC_STREAM_EVENT_RECEIVE:
 {
  printf("[strm][%p] Data received\n", QStream);

  for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
  {
   const QUIC_BUFFER *Buffer = Event->RECEIVE.Buffers + I;
   size_t Offset = 0;
   while (Offset < Buffer->Length)
   {
    if (!WtVarintPairDecoderDecode(Buffer->Buffer, Buffer->Length, &Offset, &Stream->CurFrameHeader))
    {
     break;
    }
    size_t FrameType = Stream->CurFrameHeader.Val1;
    size_t FrameLn = Stream->CurFrameHeader.Val2;
    size_t FrameLnAvail = Min(Buffer->Length - Offset, FrameLn);

    if (FrameType == H3FrameSettings)
    {
     if (Stream->Con->PeerSettings.Recvd || !FrameLn)
     {
      ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
     }
     else
     {
      if (FrameLnAvail)
      {
       size_t OgOffset = Offset;
       WtVarintPairDecoderDecode(Buffer->Buffer, Buffer->Length, &Offset, &Stream->CurSetting);
       Stream->HeaderFrameOffset += Offset - OgOffset;
       if (Stream->CurSetting.Success)
       {
        uint64_t SettingType = Stream->CurSetting.Val1;
        uint64_t SettingVal = Stream->CurSetting.Val2;
        H3SettingsInsert(&Stream->Con->PeerSettings, SettingType, SettingVal);
        if (Stream->HeaderFrameOffset < FrameLn)
        {
         continue;
        }
        else
        {
         Stream->Con->PeerSettings.Recvd = 1;
         // todo validate recvd settings
         h3_settings LocalSettings = {
          .MaxFieldSectionSize = 65536,
          .QpackMaxTableLn = 0,
          .QpackBlockedStreams = 0,
          .WtMaxSessions = 16,
          .DatagramOn = 1,
          .ConnectProtocolOn = 1,
          .WebtransportOn = 1,
         };

         QUIC_BUFFER *SendBuf = &Stream->Con->QBuf;
         a8 A = A8(Stream->Con->SettingsMsg, sizeof(Stream->Con->SettingsMsg));
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

         printf("Sending settings\n");
         if (QUIC_FAILED(MsQuic->StreamSend(Stream->Con->ControlStream, SendBuf, 1, QUIC_SEND_FLAG_NONE, 0)))
         {
          ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
         }
        }
       }
       else
       {
        break;
       }
      }
      else
      {
       break;
      }
     }
    }
    else if (FrameType == H3FrameGoaway)
    {
     ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrNoError);
    }
    else
    {
     if (Stream->Con->PeerSettings.Recvd)
     {
      ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
     }
     // ignore unkown frames
    }
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

static QUIC_STATUS
ServerUniWtStreamCallback(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
ServerUniStreamCallback(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;
 QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers;
 if (!(Event->RECEIVE.TotalBufferLength && Buf->Length))
 {
  return QUIC_STATUS_SUCCESS;
 }

 if (Stream->Id == UINT64_MAX)
 {
  size_t Offset = 0;
  if (!WtVarIntDecode(Buf->Buffer, Buf->Length, &Offset, &Stream->Type))
  {
   // todo local buffering
   ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
   return QUIC_STATUS_SUCCESS;
  }
  Buf->Buffer += (uint32_t)Offset;
  Buf->Length -= (uint32_t)Offset;
  uint32_t StreamIdSize = sizeof(Stream->Id);
  if (QUIC_FAILED(MsQuic->GetParam(QStream, QUIC_PARAM_STREAM_ID, &StreamIdSize, &Stream->Id)))
  {
   ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrInternalError);
   return QUIC_STATUS_SUCCESS;
  }
 }

 switch (Stream->Type)
 {
  case H3StreamControl:
  {
   return ServerControlStreamCallback(QStream, Ctx, Event);
  } break;
  case H3StreamUniWebtransportStream:
  {
   return ServerUniWtStreamCallback(QStream, Ctx, Event);
  } break;
  default:
  {
   ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
   return QUIC_STATUS_SUCCESS;
  } break;
 }
}

static QUIC_STATUS
ServerBidiStreamCallback(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;
 printf("Bidi stream\n");

 switch (Event->Type)
 {
  case QUIC_STREAM_EVENT_RECEIVE:
  {
   printf("Bidi stream RECEIVE\n");

   for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
   {
    QUIC_BUFFER Buf = Event->RECEIVE.Buffers[I];
    a8 View = A8(Buf.Buffer, Buf.Length);
    if (Stream->Id == UINT64_MAX)
    {
     uint32_t StreamIdSize = sizeof(Stream->Id);
     if (QUIC_FAILED(MsQuic->GetParam(QStream, QUIC_PARAM_STREAM_ID, &StreamIdSize, &Stream->Id)))
     {
      StreamSendShutdown(MsQuic, QStream, H3ErrInternalError);
      return QUIC_STATUS_SUCCESS;
     }

     // frame
     uint64_t FrameType = 0;
     uint64_t Something = 0;
     if (!(A8EatVarInt(&View, &FrameType) && A8EatVarInt(&View, &Something)))
     {
      StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
      return QUIC_STATUS_SUCCESS;
     }

     switch (FrameType)
     {
      case H3FrameHeaders:
      {
       uint64_t FrameLn = Something;
       if (FrameLn > View.Ln)
       {
        printf("Got bifurcated frame RIP\n");
        StreamSendShutdown(MsQuic, QStream, H3ErrInternalError);
        return QUIC_STATUS_SUCCESS;
       }

       
      } break;
      case H3FrameBidirWebtransportStream:
      {
       // todo validate that there is an associated connect stream
       // uint64_t SessionId = Something;

      } break;
      default:
      {
       printf("Got something weird.\n");
       StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
       return QUIC_STATUS_SUCCESS;
      } break;
     }
    }
    else
    {
     printf("Unimpl...\n");
    }
   }
  } break;
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
 SLLStackPush(Con->FirstStream, Stream);
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

  Con->QCon = Connection;
  wt_stream *Stream = ConPushStream(0, Con);
  if (QUIC_FAILED(MsQuic->StreamOpen(Connection, QUIC_STREAM_OPEN_FLAG_UNIDIRECTIONAL, ServerUniStreamCallback, Stream, &Con->ControlStream)))
  {
   // todo change to dllstack or something, proper stream dealloc
   SLLStackPop(Con->FirstStream);
   SLLStackPush(Con->FreeStream, Stream);
   ConnectionShutdown(MsQuic, Connection, H3ErrInternalError);
   return QUIC_STATUS_SUCCESS;
  }
  if (QUIC_FAILED(MsQuic->StreamStart(Con->ControlStream, QUIC_STREAM_START_FLAG_NONE)))
  {
   SLLStackPop(Con->FirstStream);
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
  if (Event->PEER_STREAM_STARTED.Flags & QUIC_STREAM_OPEN_FLAG_UNIDIRECTIONAL)
  {
   MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, (void *)ServerUniStreamCallback, (void *)Stream);
  }
  else
  {
   MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, (void *)ServerBidiStreamCallback, (void *)Stream);
  }
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


 // todo put in test file
 // {
 //  a8 A = ArPushA8(Ar, 10);
 //  a8 B = ArPushA8(Ar, 10);

 //  A.Mem[8] = 1;
 //  A.Mem[9] = 0x80;
 //  B.Mem[0] = 0;
 //  B.Mem[1] = 0;
 //  B.Mem[2] = 0x10;

 //  size_t OffsetA = 8;
 //  size_t OffsetB = 0;

 //  varint_pair_decoder Pd = {0};

 //  WtVarintPairDecoderDecode(A.Mem, A.Ln, &OffsetA, &Pd);
 //  WtVarintPairDecoderDecode(B.Mem, B.Ln, &OffsetB, &Pd);

 //  printf("Done lalal\n");
 // }


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