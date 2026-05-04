// lil msquic helper lib for doing webtransport

// silence vscode intellisense
#ifdef __INTELLISENSE__
# define CertThumbprint ""
#endif

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
typedef enum lsqpack_read_header_status lsqpack_read_header_status;
typedef enum lsqpack_dec_opts lsqpack_dec_opts;
typedef enum lsqpack_enc_status lsqpack_enc_status;
typedef enum lsqpack_enc_header_flags lsqpack_enc_header_flags;
typedef struct lsqpack_dec lsqpack_dec;
typedef struct lsqpack_enc lsqpack_enc;
typedef struct lsqpack_dec_hset_if lsqpack_dec_hset_if;
typedef struct lsxpack_header lsxpack_header;

#include <stdio.h>
#include <stdlib.h>
#include "jc.c"

typedef int32_t h3_err_kind;
enum
{
 H3ErrNoError = 0x0100,
 H3ErrGeneralProtocolError = 0x0101,
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
 H3StreamBidiWebtransportStream = 0x41,
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
 H3SettingEnableWebtransport = 0x2b603742,
 H3SettingWebtransportMaxSessions = 0x2b603743,

 H3SettingH3Draft04Datagram = 0xffd277,
 H3SettingWtMaxSessionsDraft7 = 0xc671706a,
 H3SettingWtEnabledDraft15 = 0x2c7cf000,
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

typedef uint32_t h3_protocol_kind;
enum
{
 H3ProtocolUnknown,
 H3ProtocolWebtransport,
};

typedef uint32_t h3_method_kind;
enum
{
 H3MethodUnknown,
 H3MethodGet,
 H3MethodPost,
 H3MethodPut,
 H3MethodPatch,
 H3MethodDelete,
 H3MethodConnect,
};

typedef uint32_t h3_scheme_kind;
enum
{
 H3SchemeUnknown,
 H3SchemeHttps,
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

 uint32_t WtMaxSessionsDraft7;
 uint32_t WebtransportEnabledDraft15;

 uint32_t Sent;
 uint32_t Recvd;
};

typedef struct h3_enc_header h3_enc_header;
struct h3_enc_header
{
 char Mem[512];
 lsxpack_header Header;
};

typedef struct h3_header h3_header;
struct h3_header
{
 a8 Name;
 a8 Val;
};

typedef struct h3_header_frame h3_header_frame;
struct h3_header_frame
{
 uint8_t FrameHeaderBuffer[16];
 uint8_t PrefixBuffer[32];
 uint8_t HeadersBuffer[256];
 QUIC_BUFFER Buffers[3];
};

#define WtStreamIsUni(Id) ((Id) & 0x02)
#define WtStreamIsClientInitiated(Id) (!((Id) & 0x01))

typedef struct wt_srv wt_srv;
typedef struct wt_con wt_con;
typedef struct wt_stream wt_stream;

struct wt_srv
{
 HQUIC Listener;
 QUIC_BUFFER Alpn;

 ar *Ar;
 mtx Mtx;
 QUIC_API_TABLE *MsQuic;
 HQUIC Registration;
 HQUIC Configuration;

 wt_con *First;
 wt_con *Last;
};

typedef struct wt_req wt_req;
struct wt_req
{
 char Dat[1028];
 a8 View;

 h3_protocol_kind Protocol;
 h3_method_kind Method;
 h3_scheme_kind Scheme;
 a8 Authority;
 a8 Path;
 a8 Origin;

 wt_req *Next;

 uint32_t Fail;
};

struct wt_con
{
 ar *Ar;
 rw_mtx RwMtx;
 
 h3_settings PeerSettings;
 HQUIC ControlStream;
 HQUIC QCon;
 wt_stream *SessionStream;
 lsqpack_dec Dec;
 lsqpack_enc Enc;

 wt_srv *Srv;
 wt_con *Next;
 wt_con *Prev;
 wt_req *FreeReq;

 // for sending settings response
 char SettingsMsg[64];
 QUIC_BUFFER QBuf;

 // for sending connect response
 h3_header_frame ResHeaderFrame;
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
 HQUIC QStream;

 varint_pair_decoder StreamHeader;
 varint_pair_decoder CurFrameHeader;
 size_t FrameOffset;
 varint_pair_decoder CurSetting;
 
 lsxpack_header CurDecodeHeader;
 char DecodeBuffer[4096];

 // todo track if stream closed?

 wt_con *Con;
 wt_stream *Next;
 wt_stream *Prev;
 wt_req *Req;
};



// qpack



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

static void
QpackUnblocked(void *Ctx)
{
 (void)Ctx;
}

static lsxpack_header *
QpackPrepareDecode(void *Ctx, lsxpack_header *Header, size_t Space)
{
 wt_stream *Stream = Ctx;
 if (Space > sizeof(Stream->DecodeBuffer))
 {
  printf("Header too big, %zu\n", Space);
  return 0;
 }

 if (Header)
 {
  Header->buf = Stream->DecodeBuffer;
  Header->val_len = (lsxpack_strlen_t)Space;
 }
 else
 {
  Header = &Stream->CurDecodeHeader;
  lsxpack_header_prepare_decode(Header, Stream->DecodeBuffer, 0, Space);
 }

 return Header;
}

static int
QpackProcessHeader(void *Ctx, lsxpack_header *Header)
{
 wt_stream *Stream = Ctx;
 a8 Name = A8(Header->buf + Header->name_offset, Header->name_len);
 a8 Val = A8(Header->buf + Header->val_offset, Header->val_len);

 OsRwMutexTake(Stream->Con->RwMtx, 1);
 if (!Stream->Req)
 {
  Stream->Req = Stream->Con->FreeReq;
  if (Stream->Req)
  {
   SLLStackPop(Stream->Con->FreeReq);
  }
  else
  {
   Stream->Req = ArPush(Stream->Con->Ar, wt_req, 1);
  }
  Stream->Req->View = A8(Stream->Req->Dat, sizeof(Stream->Req->Dat));
 }
 wt_req *Req = Stream->Req;
 OsRwMutexDrop(Stream->Con->RwMtx, 1);

 if (A8Eq(Name, CStr(":method")))
 {
  if (A8Eq(Val, CStr("GET")))
  {
   Req->Method = H3MethodGet;
  }
  else if (A8Eq(Val, CStr("POST")))
  {
   Req->Method = H3MethodPost;
  }
  else if (A8Eq(Val, CStr("PUT")))
  {
   Req->Method = H3MethodPut;
  }
  else if (A8Eq(Val, CStr("PATCH")))
  {
   Req->Method = H3MethodPatch;
  }
  else if (A8Eq(Val, CStr("DELETE")))
  {
   Req->Method = H3MethodDelete;
  }
  else if (A8Eq(Val, CStr("CONNECT")))
  {
   Req->Method = H3MethodConnect;
  }
 }
 else if (A8Eq(Name, CStr(":scheme")))
 {
  if (A8Eq(Val, CStr("https")))
  {
   Req->Scheme = H3SchemeHttps;
  }
 }
 else if (A8Eq(Name, CStr(":authority")))
 {
  char *Mem = Req->View.Mem;
  if (A8WriteA8(&Req->View, Val))
  {
   Req->Authority = A8(Mem, Val.Ln);
  }
  else
  {
   printf("Ran out of header space\n");
   Req->Fail = 1;
  }
 }
 else if (A8Eq(Name, CStr(":path")))
 {
  char *Mem = Req->View.Mem;
  if (A8WriteA8(&Req->View, Val))
  {
   Req->Path = A8(Mem, Val.Ln);
  }
  else
  {
   printf("Ran out of header space\n");
   Req->Fail = 1;
  }
 }
 else if (A8Eq(Name, CStr(":protocol")))
 {
  if (A8Eq(Val, CStr("webtransport-h3")))
  {
   Req->Protocol = H3ProtocolWebtransport;
  }
  else
  {
   // todo for some reason edge (chromium) sends webtransport567
   a8 WtStr = CStr("webtransport");
   if (StrStartsWith(Val.Mem, Val.Ln, WtStr.Mem, WtStr.Ln))
   {
    Req->Protocol = H3ProtocolWebtransport;
   }
  }
 }
 else if (A8Eq(Name, CStr("origin")))
 {
  char *Mem = Req->View.Mem;
  if (A8WriteA8(&Req->View, Val))
  {
   Req->Origin = A8(Mem, Val.Ln);
  }
  else
  {
   printf("Ran out of header space\n");
   Req->Fail = 1;
  }
 }
 else
 {
  printf("[HEADER] Ignoring header: %.*s %.*s\n", (uint32_t)Name.Ln, Name.Mem, (uint32_t)Val.Ln, Val.Mem);
 }

 return 0;
}



// 



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
H3HeaderEncode(lsqpack_enc *Enc, uint64_t StreamId, h3_header *Headers, size_t HeadersLn, h3_header_frame *Out)
{
 if (StreamId == UINT64_MAX)
 {
  return 0;
 }

 if (lsqpack_enc_start_header(Enc, StreamId, 0))
 {
  return 0;
 }
 size_t EncOffset = 0;
 size_t HeaderOffset = 0;
 for (size_t I = 0; I < HeadersLn; ++I)
 {
  h3_header Header = Headers[I];
  h3_enc_header EncHeader = {0};
  {
   EncHeader.Header.buf = EncHeader.Mem;
   EncHeader.Header.name_offset = 0;
   EncHeader.Header.name_len = (lsxpack_strlen_t)Header.Name.Ln;
   EncHeader.Header.val_offset = (lsxpack_strlen_t)Header.Name.Ln;
   EncHeader.Header.val_len = (lsxpack_strlen_t)Header.Val.Ln;
   memcpy(EncHeader.Mem, Header.Name.Mem, Header.Name.Ln);
   memcpy(EncHeader.Mem + Header.Name.Ln, Header.Val.Mem, Header.Val.Ln);
  }

  // todo EncStreamMem should go in the stream object, reference msh3
  char EncStreamMem[256] = {0};
  size_t EncStreamLn = sizeof(EncStreamMem) - EncOffset;
  size_t HeaderLn = sizeof(Out->HeadersBuffer) - HeaderOffset;
  lsqpack_enc_status Res = lsqpack_enc_encode(Enc, EncStreamMem + EncOffset, &EncStreamLn, Out->HeadersBuffer + HeaderOffset, &HeaderLn, &EncHeader.Header, 0);
  if (Res != LQES_OK)
  {
   return 0;
  }
  EncOffset += EncStreamLn;
  HeaderOffset += HeaderLn;
 }
 Out->Buffers[2] = (QUIC_BUFFER){.Buffer = Out->HeadersBuffer, .Length = (uint32_t)HeaderOffset};

 lsqpack_enc_header_flags Flags = 0;
 ssize_t PrefixLn = lsqpack_enc_end_header(Enc, (char *)&Out->PrefixBuffer, sizeof(Out->PrefixBuffer), &Flags);
 if (PrefixLn < 0)
 {
  return 0;
 }
 Out->Buffers[1] = (QUIC_BUFFER){.Buffer = Out->PrefixBuffer, .Length = (uint32_t)PrefixLn};
 // todo send enc output, see msh3

 {
  a8 FrameHeaderView = A8(Out->FrameHeaderBuffer, sizeof(Out->FrameHeaderBuffer));
  size_t HeaderFrameLn = PrefixLn + HeaderOffset;
  A8WriteVarInt(&FrameHeaderView, H3FrameHeaders);
  A8WriteVarInt(&FrameHeaderView, HeaderFrameLn);

  Out->Buffers[0] = (QUIC_BUFFER){.Buffer = Out->FrameHeaderBuffer, .Length = sizeof(Out->FrameHeaderBuffer) - (uint32_t)FrameHeaderView.Ln};
 }

 return 1;
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
  case H3SettingEnableWebtransport:
  {
   Out->WebtransportOn = (uint32_t)SettingVal;
  } break;
  case H3SettingWebtransportMaxSessions:
  {
   Out->WtMaxSessions = (uint32_t)SettingVal;
  } break;
  // todo distinct struct field for this?
  case H3SettingH3Draft04Datagram:
  {
   Out->DatagramOn = (uint32_t)SettingVal;
  } break;
  case H3SettingWtMaxSessionsDraft7:
  {
   Out->WtMaxSessionsDraft7 = (uint32_t)SettingVal;
  } break;
  case H3SettingWtEnabledDraft15:
  {
   Out->WebtransportEnabledDraft15 = (uint32_t)SettingVal;
  } break;
  default:
  {
   Ret = 0;
   printf("[SETTING] Recvd unknown setting: %zd %zd\n", SettingType, SettingVal);
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

static void
H3SettingsLog(h3_settings *Settings)
{
 printf("[SETTING] MaxFieldSectionSize: %d\n", Settings->MaxFieldSectionSize);
 printf("[SETTING] QpackMaxTableLn: %d\n", Settings->QpackMaxTableLn);
 printf("[SETTING] QpackBlockedStreams: %d\n", Settings->QpackBlockedStreams);
 printf("[SETTING] WtMaxSessions: %d\n", Settings->WtMaxSessions);

 printf("[SETTING] DatagramOn: %d\n", Settings->DatagramOn);
 printf("[SETTING] ConnectProtocolOn: %d\n", Settings->ConnectProtocolOn);
 printf("[SETTING] WebtransportOn: %d\n", Settings->WebtransportOn);
 printf("[SETTING] WebtransportEnabledDraft15: %d\n", Settings->WebtransportEnabledDraft15);

 printf("[SETTING] Sent: %d\n", Settings->Sent);
 printf("[SETTING] Recvd: %d\n", Settings->Recvd);
}

static uint32_t
H3SettingsSer(h3_settings *Settings, char *Mem, size_t Ln, a8 *Out)
{
 uint32_t Ret = 1;
 a8 A = A8(Mem, Ln);
 a8 AView = A;

 char TmpArr[256] = {0};
 a8 TmpSettings = A8(TmpArr, sizeof(TmpArr));
 a8 TmpSettingsView = TmpSettings;

 A8WriteVarInt(&TmpSettingsView, H3SettingMaxFieldSectionSize);
 A8WriteVarInt(&TmpSettingsView, Settings->MaxFieldSectionSize);
 A8WriteVarInt(&TmpSettingsView, H3SettingQpackMaxTableCapacity);
 A8WriteVarInt(&TmpSettingsView, Settings->QpackMaxTableLn);
 A8WriteVarInt(&TmpSettingsView, H3SettingQpackBlockedStreams);
 A8WriteVarInt(&TmpSettingsView, Settings->QpackBlockedStreams);
 A8WriteVarInt(&TmpSettingsView, H3SettingWebtransportMaxSessions);
 A8WriteVarInt(&TmpSettingsView, Settings->WtMaxSessions);
 A8WriteVarInt(&TmpSettingsView, H3SettingH3Datagram);
 A8WriteVarInt(&TmpSettingsView, Settings->DatagramOn);
 A8WriteVarInt(&TmpSettingsView, H3SettingEnableConnectProtocol);
 A8WriteVarInt(&TmpSettingsView, Settings->ConnectProtocolOn);
 A8WriteVarInt(&TmpSettingsView, H3SettingEnableWebtransport);
 A8WriteVarInt(&TmpSettingsView, Settings->WebtransportOn);

 // todo keep here for future updates to protocol?
 // A8WriteVarInt(&TmpSettingsView, H3SettingWtMaxSessionsDraft7);
 // A8WriteVarInt(&TmpSettingsView, Settings->WtMaxSessionsDraft7);
 // A8WriteVarInt(&TmpSettingsView, H3SettingWtEnabledDraft15);
 // A8WriteVarInt(&TmpSettingsView, Settings->WebtransportEnabledDraft15);

 a8 FinalTmpSettings = A8(TmpSettings.Mem, TmpSettings.Ln - TmpSettingsView.Ln);
 
 Ret &= A8WriteVarInt(&AView, H3StreamControl);
 Ret &= A8WriteVarInt(&AView, H3FrameSettings);
 Ret &= A8WriteVarInt(&AView, FinalTmpSettings.Ln);
 Ret &= A8WriteA8(&AView, FinalTmpSettings);

 Out->Mem = A.Mem;
 Out->Ln = A.Ln - AView.Ln;
 return Ret;
}

static uint32_t
ReqConnectValidate(wt_req *Req)
{
 return !Req->Fail
   && Req->Method == H3MethodConnect
   && Req->Protocol == H3ProtocolWebtransport
   && Req->Scheme == H3SchemeHttps
   && Req->Authority.Ln
   && Req->Path.Ln
   && Req->Origin.Ln;
}

static void
ConAlloc(wt_srv *Srv, wt_con *Con, ar * Ar)
{
 Con->RwMtx = OsRwMutexAlloc();
 Con->Ar = Ar;
 static lsqpack_dec_hset_if QpackDecIf = {
  .dhi_unblocked = QpackUnblocked,
  .dhi_prepare_decode = QpackPrepareDecode,
  .dhi_process_header = QpackProcessHeader,
 };
 lsqpack_dec_init(&Con->Dec, 0, 0, 0, &QpackDecIf, (lsqpack_dec_opts)0);
 lsqpack_enc_preinit(&Con->Enc, 0);
 Con->Srv = Srv;
 DLLPushFront(Srv->First, Srv->Last, Con);
}

static void
ConFree(wt_con *Con)
{
 DLLRemove(Con->Srv->First, Con->Srv->Last, Con);
 lsqpack_dec_cleanup(&Con->Dec);
 ArRelease(Con->Ar);
 OsRwMutexRelease(Con->RwMtx);
 MemoryZeroStruct(Con);
}

static void
StreamPush(size_t Id, wt_con *Con, wt_stream *Stream)
{
 OsRwMutexTake(Con->RwMtx, 1);
 {
  Stream->Id = Id;
  Stream->Con = Con;
 }
 OsRwMutexDrop(Con->RwMtx, 1);
}

static void
StreamFree(wt_stream *Stream)
{
 OsRwMutexTake(Stream->Con->RwMtx, 1);
 {
  if (Stream->Req)
  {
   SLLStackPush(Stream->Con->FreeReq, Stream->Req);
  }
 }
 OsRwMutexDrop(Stream->Con->RwMtx, 1);
}

static QUIC_STATUS
WtControlStreamCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
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

  OsRwMutexTake(Stream->Con->RwMtx, 1);
  for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
  {
   QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
   size_t Offset = 0;
   while (Offset < Buf->Length)
   {
    if (!WtVarintPairDecoderDecode(Buf->Buffer, Buf->Length, &Offset, &Stream->CurFrameHeader))
    {
     break;
    }
    size_t FrameType = Stream->CurFrameHeader.Val1;
    size_t FrameLn = Stream->CurFrameHeader.Val2;
    size_t Avail = Min(Buf->Length - Offset, FrameLn - Stream->FrameOffset);

    if (FrameType == H3FrameSettings)
    {
     if (Stream->Con->PeerSettings.Recvd || !FrameLn)
     {
      ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
      break;
     }
     if (Avail)
     {
      size_t OgOffset = Offset;
      WtVarintPairDecoderDecode(Buf->Buffer, Offset + Avail, &Offset, &Stream->CurSetting);
      Stream->FrameOffset += Offset - OgOffset;
      if (Stream->CurSetting.Success)
      {
       uint64_t SettingType = Stream->CurSetting.Val1;
       uint64_t SettingVal = Stream->CurSetting.Val2;
       H3SettingsInsert(&Stream->Con->PeerSettings, SettingType, SettingVal);
       Stream->CurSetting = (varint_pair_decoder){0};
       if (Stream->FrameOffset < FrameLn)
       {
        continue;
       }
       Stream->FrameOffset = 0;
       Stream->CurFrameHeader = (varint_pair_decoder){0};
       Stream->Con->PeerSettings.Recvd = 1;
       printf("[SETTING] Parsed peer settings:\n");
       H3SettingsLog(&Stream->Con->PeerSettings);
       // todo validate recvd settings

       h3_settings LocalSettings = {
        .MaxFieldSectionSize = 65536,
        .QpackMaxTableLn = 0,
        .QpackBlockedStreams = 0,
        .WtMaxSessions = 16,
        .DatagramOn = 1,
        .ConnectProtocolOn = 1,
        .WebtransportOn = 1,
        .WebtransportEnabledDraft15 = 1,
       };
       QUIC_BUFFER *SendBuf = &Stream->Con->QBuf;
       a8 Msg = {0};
       printf("[SETTING] Sending response:\n");
       H3SettingsLog(&LocalSettings);
       if (!H3SettingsSer(&LocalSettings, Stream->Con->SettingsMsg, sizeof(Stream->Con->SettingsMsg), &Msg))
       {
        ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrInternalError);
        break;
       }
       SendBuf->Buffer = Msg.Mem;
       SendBuf->Length = (uint32_t)Msg.Ln;

       if (QUIC_FAILED(MsQuic->StreamSend(Stream->Con->ControlStream, SendBuf, 1, QUIC_SEND_FLAG_NONE, 0)))
       {
        ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
        break;
       }

       // in the future the negotiated qpack params will be passed in
       if (lsqpack_enc_init(&Stream->Con->Enc, 0, 0, 0, 0, LSQPACK_ENC_OPT_STAGE_2, 0, 0))
       {
        ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrInternalError);
        break;
       }
      }
      else if (Avail >= (FrameLn - Stream->FrameOffset))
      {
       // this should've succeeded, must be bad req data
       ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
       break;
      }
     }
    }
    else if (FrameType == H3FrameGoaway)
    {
     Offset += Avail;
     Stream->FrameOffset += Avail;
     if (Stream->FrameOffset == FrameLn)
     {
      Stream->FrameOffset = 0;
      MemoryZeroStruct(&Stream->CurFrameHeader);
     }
     ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrNoError);
    }
    else
    {
     if (!Stream->Con->PeerSettings.Recvd)
     {
      ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
     }
     Offset += Avail;
     Stream->FrameOffset += Avail;
     if (Stream->FrameOffset == FrameLn)
     {
      Stream->FrameOffset = 0;
      MemoryZeroStruct(&Stream->CurFrameHeader);
     }
     // ignore unkown frames
    }
   }
  }
  OsRwMutexDrop(Stream->Con->RwMtx, 1);
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
WtUnidiWtCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 printf("[STRM] Unidi application stream recv\n");
 uint64_t SessionId = Stream->StreamHeader.Val2;
 if (SessionId != Stream->Con->SessionStream->Id)
 {
  printf("[STRM] Unidi stream bad session id\n");
  return QUIC_STATUS_SUCCESS;
 }

 

 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
WtUnidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;

 if (Event->Type == QUIC_STREAM_EVENT_RECEIVE)
 {
  if (!Event->RECEIVE.TotalBufferLength)
  {
   return QUIC_STATUS_SUCCESS;
  }

  if (Stream->Id == UINT64_MAX)
  {
   uint32_t GotStreamHeader = 0;
   for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
   {
    QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
    size_t Offset = 0;
    WtVarintPairDecoderDecode(Buf->Buffer, Buf->Length, &Offset, &Stream->StreamHeader);
    varint_pair_decoder *Header = &Stream->StreamHeader;

    // some headers have a 2 varint header, others have a 1 varint header
    // in the "normal" 1 varint case, we should only trim 1 byte and ignore the second varint
    uint32_t GotH3Uni = (Header->Got1 && (Header->Val1 == H3StreamControl || Header->Val1 == H3StreamQpackEncoder || Header->Val1 == H3StreamQpackEncoder));
    Buf->Buffer += GotH3Uni ? 1 : (uint32_t)Offset;
    Buf->Length -= GotH3Uni ? 1 : (uint32_t)Offset;

    GotStreamHeader = (Header->Success || GotH3Uni);
    if (GotStreamHeader)
    {
     break;
    }
   }

   varint_pair_decoder *Header = &Stream->StreamHeader;
   if (GotStreamHeader)
   {
    uint32_t StreamIdSize = sizeof(Stream->Id);
    if (QUIC_FAILED(MsQuic->GetParam(QStream, QUIC_PARAM_STREAM_ID, &StreamIdSize, &Stream->Id)))
    {
     ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrInternalError);
     return QUIC_STATUS_SUCCESS;
    }
   }
   else
   {
    return QUIC_STATUS_SUCCESS;
   }
  }
  // By this point, stream header and stream id should be known

  uint64_t StreamType = Stream->StreamHeader.Val1;
  switch (StreamType)
  {
   case H3StreamControl:
   {
    printf("[STRM] Recv control stream\n");
    return WtControlStreamCb(QStream, Ctx, Event);
   } break;
   case H3StreamQpackEncoder:
   {
    printf("[STRM] Recv qpack encoder\n");
    return QUIC_STATUS_SUCCESS;
   } break;
   case H3StreamQpackDecoder:
   {
    printf("[STRM] Recv qpack decoder\n");
    return QUIC_STATUS_SUCCESS;
   } break;
   case H3StreamUniWebtransportStream:
   {
    return WtUnidiWtCb(QStream, Ctx, Event);
   } break;
   default:
   {
    ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrGeneralProtocolError);
    return QUIC_STATUS_SUCCESS;
   } break;
  }
 }
 return QUIC_STATUS_SUCCESS;
}

static HQUIC
UnidiStreamOpen(QUIC_API_TABLE *MsQuic, HQUIC QCon, QUIC_STREAM_CALLBACK_HANDLER Cb, void *CbCtx)
{
 HQUIC QStream = 0;
 if (QUIC_SUCCEEDED(MsQuic->StreamOpen(QCon, QUIC_STREAM_OPEN_FLAG_UNIDIRECTIONAL, Cb, CbCtx, &QStream)))
 {
  if (QUIC_FAILED(MsQuic->StreamStart(QStream, QUIC_STREAM_START_FLAG_NONE)))
  {
   MsQuic->StreamClose(QStream);
   QStream = 0;
  }
 }
 else
 {
  QStream = 0;
 }
 return QStream;
}


static QUIC_STATUS
WtBidiWtRecv(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 return QUIC_STATUS_SUCCESS;
}

// todo proper sessionstream ptr free
/*
frameleft = frameln - frameoffset
bufleft = bufln - bufoffset
avail = min(frameleft, bufleft)

avail >= frameleft   this should succeed, but if fail then bad req
avail < frameleft    can succeed or fail, iteratively try again
*/
// todo con->rwmtx lock necessary here? lsqpack doesn't like it
static QUIC_STATUS
WtBidiH3Recv(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;

 for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
 {
  QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
  size_t Offset = 0;
  while (Offset < Buf->Length)
  {
   if (!WtVarintPairDecoderDecode(Buf->Buffer, Buf->Length, &Offset, &Stream->CurFrameHeader))
   {
    break;
   }
   size_t FrameType = Stream->CurFrameHeader.Val1;
   size_t FrameLn = Stream->CurFrameHeader.Val2;
   size_t Avail = Min(Buf->Length - Offset, FrameLn - Stream->FrameOffset);

   switch (FrameType)
   {
    case H3FrameHeaders:
    {
     lsqpack_read_header_status Res;
     uint8_t *ToRead = Buf->Buffer + Offset;
     if (Stream->FrameOffset)
     {
      Res = lsqpack_dec_header_read(&Stream->Con->Dec, (void *)Stream, &ToRead, Avail, 0, 0);
     }
     else
     {
      Res = lsqpack_dec_header_in(&Stream->Con->Dec, (void *)Stream, Stream->Id, FrameLn, &ToRead, Avail, 0, 0);
     }

     if (Res == LQRHS_DONE)
     {
      Offset += Avail;
      Stream->FrameOffset += Avail;

      if (ReqConnectValidate(Stream->Req))
      {
       if (!Stream->Con->PeerSettings.Recvd || Stream->Con->SessionStream)
       {
        printf("Bad connnect req\n");
        StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
        goto Done;
       }
       else
       {
        Stream->Con->SessionStream = Stream;
        printf("Recvd valid connect req\n");

        h3_header Headers[] = {
         (h3_header){.Name = CStr(":status"), .Val = CStr("200")},
         // todo not sure if this is needed? Chrome + Firefox send this header...
         // (h3_header){.Name = CStr("sec-webtransport-http3-draft02"), .Val = CStr("1")},
        };
        H3HeaderEncode(&Stream->Con->Enc, Stream->Id, Headers, ArrLen(Headers), &Stream->Con->ResHeaderFrame);

        if (QUIC_FAILED(MsQuic->StreamSend(QStream, Stream->Con->ResHeaderFrame.Buffers, ArrLen(Stream->Con->ResHeaderFrame.Buffers), QUIC_SEND_FLAG_NONE, 0)))
        {
         StreamSendShutdown(MsQuic, QStream, H3ErrInternalError);
         goto Done;
        }
        printf("Sent connect response\n");
       }
      }
      else
      {
       printf("Bad connnect req\n");
       StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
       goto Done;
      }
     }
     else if (Res == LQRHS_NEED)
     {
      // go to next buf, NEED MOAR DATA
      Stream->FrameOffset += Avail;
      Offset += Avail;
     }
    } break;
    case H3FrameData:
    {
     printf("Recv data frame\n");
     Stream->FrameOffset += Avail;
     Offset += Avail;
    } break;
    default:
    {
     printf("Recv unknown bidi frame\n");
     Stream->FrameOffset += Avail;
     Offset += Avail;
    } break;
   }

   if (Stream->FrameOffset == FrameLn)
   {
    MemoryZeroStruct(&Stream->CurFrameHeader);
    Stream->FrameOffset = 0;
   }
  }
 }

Done:
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
WtBidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;
 switch (Event->Type)
 {
  case QUIC_STREAM_EVENT_RECEIVE:
  {
   printf("Bidi stream RECEIVE\n");
   if (!(Event->RECEIVE.TotalBufferLength && Event->RECEIVE.BufferCount))
   {
    return QUIC_STATUS_SUCCESS;
   }

   if (Stream->Id == UINT64_MAX)
   {
    for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
    {
     QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
     size_t Offset = 0;
     WtVarintPairDecoderDecode(Buf->Buffer, Buf->Length, &Offset, &Stream->StreamHeader);
     Buf->Buffer += (uint32_t)Offset;
     Buf->Length -= (uint32_t)Offset;
    }
    if (Stream->StreamHeader.Success)
    {
     if (Stream->StreamHeader.Val1 == H3FrameHeaders)
     {
      Stream->CurFrameHeader = Stream->StreamHeader;
     }

     uint32_t StreamIdSize = sizeof(Stream->Id);
     if (QUIC_FAILED(MsQuic->GetParam(QStream, QUIC_PARAM_STREAM_ID, &StreamIdSize, &Stream->Id)))
     {
      ConnectionShutdown(MsQuic, Stream->Con->QCon, H3ErrInternalError);
      return QUIC_STATUS_SUCCESS;
     }
    }
    else
    {
     return QUIC_STATUS_SUCCESS;
    }
   }

   if (Stream->StreamHeader.Val1 == H3FrameHeaders)
   {
    return WtBidiH3Recv(QStream, Ctx, Event);
   }
   else if (Stream->StreamHeader.Val1 == H3StreamBidiWebtransportStream)
   {
    return WtBidiWtRecv(QStream, Ctx, Event);
   }
   else
   {
    StreamSendShutdown(MsQuic, QStream, H3ErrGeneralProtocolError);
    return QUIC_STATUS_SUCCESS;
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

static QUIC_STATUS
WtConCb(HQUIC QCon, void *Ctx, QUIC_CONNECTION_EVENT *Event, void *UnidiCb, void *BidiCb, void *CbCtx)
{
 wt_con *Con = (wt_con *)Ctx;
 QUIC_API_TABLE *MsQuic = Con->Srv->MsQuic;

 switch (Event->Type)
 {
 case QUIC_CONNECTION_EVENT_CONNECTED:
 {
  // The handshake has completed for the connection.
  printf("[conn][%p] Connected\n", QCon);

  OsRwMutexTake(Con->RwMtx, 1);
  Con->QCon = QCon;
  wt_stream *Stream = ArPush(Con->Ar, wt_stream, 1);
  OsRwMutexDrop(Con->RwMtx, 1);
  StreamPush(0, Con, Stream);
  Stream->QStream = UnidiStreamOpen(MsQuic, QCon, WtUnidiCb, Stream);
  Con->ControlStream = Stream->QStream;
  if (Stream->QStream)
  {
   MsQuic->ConnectionSendResumptionTicket(QCon, QUIC_SEND_RESUMPTION_FLAG_NONE, 0, NULL);
  }
  else
  {
   StreamFree(Stream);
   ConnectionShutdown(MsQuic, QCon, H3ErrInternalError);
  }
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_TRANSPORT:
 {
  // The connection has been shut down by the transport. Generally, this
  // is the expected way for the connection to shut down with this
  // protocol, since we let idle timeout kill the connection.
  if (Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status == QUIC_STATUS_CONNECTION_IDLE)
  {
   printf("[conn][%p] Successfully shut down on idle.\n", QCon);
  }
  else
  {
   printf("[conn][%p] Shut down by transport, 0x%x\n", QCon, Event->SHUTDOWN_INITIATED_BY_TRANSPORT.Status);
  }
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_INITIATED_BY_PEER:
 {
  // The connection was explicitly shut down by the peer.
  printf("[conn][%p] Shut down by peer, 0x%llu\n", QCon, (unsigned long long)Event->SHUTDOWN_INITIATED_BY_PEER.ErrorCode);
  break;
 }
 case QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE:
 {
  // The connection has completed the shutdown process and is ready to be
  // safely cleaned up.
  printf("[conn][%p] All done\n", QCon);
  MsQuic->ConnectionClose(QCon);
  break;
 }
 case QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED:
 {
  printf("[strm][%p] Peer started\n", Event->PEER_STREAM_STARTED.Stream);

  if (Event->PEER_STREAM_STARTED.Flags & QUIC_STREAM_OPEN_FLAG_UNIDIRECTIONAL)
  {
   MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, UnidiCb, (void *)CbCtx);
  }
  else
  {
   MsQuic->SetCallbackHandler(Event->PEER_STREAM_STARTED.Stream, BidiCb, (void *)CbCtx);
  }
  break;
 }
 case QUIC_CONNECTION_EVENT_RESUMED:
 {
  // The connection succeeded in doing a TLS resumption of a previous
  // connection's session.
  printf("[conn][%p] Connection resumed!\n", QCon);
  break;
 }
 case QUIC_CONNECTION_EVENT_DATAGRAM_RECEIVED:
 {
  QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->DATAGRAM_RECEIVED.Buffer;
  QUIC_RECEIVE_FLAGS RecvFlags = Event->DATAGRAM_RECEIVED.Flags;
  a8 View = A8(Buf->Buffer, Buf->Length);
  uint64_t QuarterId = 0;
  A8EatVarInt(&View, &QuarterId);
  OsRwMutexTake(Con->RwMtx, 0);
  if (Con->SessionStream && QuarterId == (Con->SessionStream->Id / 4))
  {
   printf("[DGRAM] QuarterId: %zd, Payload: %.*s\n", QuarterId, (uint32_t)View.Ln, View.Mem);
  }
  else
  {
   printf("[DGRAM] Recv dgram with bad quarter id\n");
  }
  OsRwMutexDrop(Con->RwMtx, 0);

 } break;
 default:
 {
  break;
 }
 }
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
WtListenCb(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event, void *ConCb, void *ConCbCtx)
{
 wt_srv *Srv = (wt_srv *)Ctx;
 QUIC_STATUS Status = QUIC_STATUS_NOT_SUPPORTED;
 switch (Event->Type)
 {
 case QUIC_LISTENER_EVENT_NEW_CONNECTION:
 {
  Srv->MsQuic->SetCallbackHandler(Event->NEW_CONNECTION.Connection, ConCb, (void *)ConCbCtx);
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

// static QUIC_STATUS
// WtDefaultListenCb(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event, void *ConCb)
// {
//  return WtListenCb(Listener, Ctx, Event, WtConCb);
// }

// The arena given is owned by the server
static void
WtInit(ar *Ar, wt_srv *Srv)
{
 ar_tmp Pos = ArTmpGet(Ar);
 Srv->Ar = Ar;
 QUIC_STATUS Status = QUIC_STATUS_SUCCESS;
 uint32_t Succeeded = 0;
 if (QUIC_SUCCEEDED(Status = MsQuicOpen2(&Srv->MsQuic)))
 {
  const QUIC_REGISTRATION_CONFIG RegConfig = { "quicsample", QUIC_EXECUTION_PROFILE_LOW_LATENCY };
  if (QUIC_SUCCEEDED(Status = Srv->MsQuic->RegistrationOpen(&RegConfig, &Srv->Registration)))
  {
   if (Srv->MsQuic && Srv->Registration)
   {
    uint64_t IdleTimeoutMs = 30000;
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
    Settings.KeepAliveIntervalMs = 10000;
    Settings.IsSet.KeepAliveIntervalMs = TRUE;
    Settings.SendBufferingEnabled = 0;
    Settings.IsSet.SendBufferingEnabled = TRUE;

    QUIC_CERTIFICATE_HASH Thumbprint = {0};
    DecodeHexBuffer(CertThumbprint, sizeof(Thumbprint.ShaHash), Thumbprint.ShaHash);
    QUIC_CREDENTIAL_CONFIG CredConfig = {0};
    CredConfig.Type = QUIC_CREDENTIAL_TYPE_CERTIFICATE_HASH;
    CredConfig.CertificateHash = &Thumbprint;

    a8 AlpnStr = CStr("h3");
    Srv->Alpn = (QUIC_BUFFER){ (uint32_t)AlpnStr.Ln, (uint8_t*)AlpnStr.Mem };
    if (QUIC_SUCCEEDED(Status = Srv->MsQuic->ConfigurationOpen(Srv->Registration, &Srv->Alpn, 1, &Settings, sizeof(Settings), NULL, &Srv->Configuration)))
    {
     if (QUIC_SUCCEEDED(Status = Srv->MsQuic->ConfigurationLoadCredential(Srv->Configuration, &CredConfig)))
     {
      Succeeded = 1;
     }
     else
     {
      printf("ConfigurationLoadCredential failed, 0x%x!\n", Status);
     }
    }
    else
    {
     printf("ConfigurationOpen failed, 0x%x!\n", Status);
    }
   }
  }
  else
  {
   printf("RegistrationOpen failed, 0x%x!\n", Status);
  }
 }
 else
 {
  printf("MsQuicOpen2 failed, 0x%x!\n", Status);
 }

 if (!Succeeded)
 {
  ArTmpEnd(Pos);
 }
}

static uint32_t
WtListen(wt_srv *Srv, uint16_t Port, QUIC_LISTENER_CALLBACK_HANDLER ListenCb, void *ListenCbCtx)
{
 uint32_t Succeeded = 0;
 QUIC_STATUS Status = QUIC_STATUS_SUCCESS;
 QUIC_ADDR Address = {0};
 QuicAddrSetFamily(&Address, QUIC_ADDRESS_FAMILY_UNSPEC);
 QuicAddrSetPort(&Address, Port);
 if (QUIC_SUCCEEDED(Status = Srv->MsQuic->ListenerOpen(Srv->Registration, ListenCb, ListenCbCtx, &Srv->Listener)))
 {
  if (QUIC_SUCCEEDED(Status = Srv->MsQuic->ListenerStart(Srv->Listener, &Srv->Alpn, 1, &Address)))
  {
   Succeeded = 1;
  }
  else
  {
   printf("ListenerStart failed, 0x%x!\n", Status);
  }
 }
 else
 {
  printf("ListenerOpen failed, 0x%x!\n", Status);
 }
 return Succeeded;
}

static void
WtClose(wt_srv *Srv)
{
 if (Srv && Srv->MsQuic)
 {
  if (Srv->Listener)
  {
   Srv->MsQuic->ListenerClose(Srv->Listener);
  }
  if (Srv->Configuration)
  {
   Srv->MsQuic->ConfigurationClose(Srv->Configuration);
  }
  if (Srv->Registration)
  {
   Srv->MsQuic->RegistrationClose(Srv->Registration);
  }
  MsQuicClose(Srv->MsQuic);
 }
}