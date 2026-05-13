#include "wt.c"

typedef uint8_t header_kind;
enum
{
 HeaderFrame,
 HeaderPub,
 HeaderSub,
};

#pragma pack(push, 1)
typedef struct frame_header frame_header;
struct frame_header
{
 header_kind FrameType;
 uint32_t FrameId;
 uint32_t TimeStampUs;
 uint8_t TrackId;
 uint8_t Metadata;
};
#pragma pack(pop)

#pragma pack(push, 1)
typedef struct pub_header pub_header;
struct pub_header
{
 header_kind FrameType;
};
#pragma pack(pop)

#pragma pack(push, 1)
typedef struct sub_header sub_header;
struct sub_header
{
 header_kind FrameType;
 uint32_t Ln;
};
#pragma pack(pop)


typedef struct frame_header_buf frame_header_buf;
struct frame_header_buf
{
 union
 {
  uint8_t Mem[sizeof(frame_header)];
  frame_header Header;
 };
 uint8_t Ln;
};

typedef struct my_srv my_srv;
typedef struct my_con my_con;
typedef struct my_stream my_stream;
typedef struct frame_chunk frame_chunk;

struct my_srv
{
 wt_srv Srv;
 rw_mtx RwMtx;
 my_con *First;
 my_con *Last;
};

struct my_con
{
 ar *Ar;

 rw_mtx RwMtx;
 my_srv *MySrv;
 my_con *Next;
 my_con *Prev;
 my_stream *FirstIn;
 my_stream *LastIn;
 my_stream *FirstOut;
 my_stream *LastOut;
 my_stream *Free;
 frame_chunk *FreeFrameChunk;

 wt_con Con;
};

struct frame_chunk
{
 char Mem[2048];
 size_t Ln;
 frame_chunk *Next;
 frame_chunk *Prev;
 QUIC_BUFFER Buf;
 my_stream *MyStream;
};

struct my_stream
{
 uint32_t IsInStream;
 // outgoing streams are mapped to an incoming stream
 uint64_t OwningStreamId;
 frame_header_buf FrameHeader;

 wt_stream Stream;

 my_con *MyCon;
 my_stream *Next;
 my_stream *Prev;

 frame_chunk *FirstChunk;
 frame_chunk *LastChunk;

 // for debugging
 uint32_t SendLn;
};

#define FrameHeaderIsReady(U64Buf) ((U64Buf)->Ln == sizeof((U64Buf)->Mem))

// Getters needed for unaligned access
static uint32_t
FrameHeaderGetFrameId(frame_header_buf *Buf)
{
 uint32_t Ret = 0;
 StaticAssert(ret_geq_frame_id, sizeof(Ret) >= sizeof(Buf->Header.FrameId));
 memcpy(&Ret, &Buf->Header.FrameId, sizeof(Buf->Header.FrameId));
 return Ret;
}

static my_srv *
MySrvAlloc()
{
 ar *Ar = ArAlloc();
 my_srv *MySrv = ArPush(Ar, my_srv, 1);
 MySrv->RwMtx = OsRwMutexAlloc();
 WtInit(Ar, &MySrv->Srv);
 return MySrv;
}

static my_con *
MyConAlloc(my_srv *MySrv)
{
 ar *Ar = ArAlloc();
 my_con *MyCon = ArPush(Ar, my_con, 1);
 MyCon->Ar = Ar;
 MyCon->RwMtx = OsRwMutexAlloc();
 MyCon->MySrv = MySrv;
 ar *ConAr = ArAlloc();
 ConAlloc(&MySrv->Srv, &MyCon->Con, ConAr);

 OsRwMutexTake(MySrv->RwMtx, 1);
 DLLPushFront(MySrv->First, MySrv->Last, MyCon);
 OsRwMutexDrop(MySrv->RwMtx, 1);

 return MyCon;
}

static void
MyConFree(my_con *MyCon)
{
 rw_mtx MyConRwMtx = MyCon->RwMtx;
 rw_mtx MySrvRwMtx = MyCon->MySrv->RwMtx;
 OsRwMutexTake(MySrvRwMtx, 1);
 OsRwMutexTake(MyConRwMtx, 1);

 {
  DLLRemove(MyCon->MySrv->First, MyCon->MySrv->Last, MyCon);

  ConFree(&MyCon->Con);
  ArRelease(MyCon->Ar);
 }

 OsRwMutexDrop(MyConRwMtx, 1);
 OsRwMutexRelease(MyConRwMtx);
 OsRwMutexDrop(MySrvRwMtx, 1);
}

static frame_chunk *
FrameChunkPush(my_con *MyCon, my_stream *MyStream)
{
 DWORD ThreadId = GetCurrentThreadId();
 ThreadId;
 OsRwMutexTake(MyCon->RwMtx, 1);

 frame_chunk *Chunk = MyCon->FreeFrameChunk;
 if (Chunk)
 {
  SLLStackPop(MyCon->FreeFrameChunk);
 }
 else
 {
  Chunk = ArPush(MyCon->Ar, frame_chunk, 1);
 }
 Chunk->MyStream = MyStream;

 OsRwMutexDrop(MyCon->RwMtx, 1);

 DLLPushBack(MyStream->FirstChunk, MyStream->LastChunk, Chunk);

 return Chunk;
}

static void
FrameChunkFree(my_con *MyCon, frame_chunk *Chunk)
{
 DLLRemove(Chunk->MyStream->FirstChunk, Chunk->MyStream->LastChunk, Chunk);
 MemoryZeroStruct(Chunk);
 OsRwMutexTake(MyCon->RwMtx, 1);
 SLLStackPush(MyCon->FreeFrameChunk, Chunk);
 OsRwMutexDrop(MyCon->RwMtx, 1);
}

static my_stream *
MyStreamPush(my_con *MyCon, uint32_t IsInStream)
{
 OsRwMutexTake(MyCon->RwMtx, 1);

 // init my_stream
 my_stream *MyStream = MyCon->Free;
 if (MyStream)
 {
  SLLStackPop(MyCon->Free);
 }
 else
 {
  MyStream = ArPush(MyCon->Ar, my_stream, 1);
 }
 MyStream->MyCon = MyCon;
 if (IsInStream)
 {
  DLLPushFront(MyCon->FirstIn, MyCon->LastIn, MyStream);
 }
 else
 {
  DLLPushFront(MyCon->FirstOut, MyCon->LastOut, MyStream);
 }
 MyStream->IsInStream = IsInStream;

 OsRwMutexDrop(MyCon->RwMtx, 1);

 // init wt_stream
 StreamPush(UINT64_MAX, &MyCon->Con, &MyStream->Stream);

 return MyStream;
}

static void
MyStreamFree(QUIC_API_TABLE *MsQuic, my_stream *MyStream)
{
 my_con *MyCon = MyStream->MyCon;
 WtLogDebug("[STRM][%p][%zd] Freeing stream\n", MyStream->Stream.QStream, MyStream->Stream.Id);
 if (MyStream->FirstChunk)
 {
  WtLogErr("[STRM][%p][%zd] ERROR: Chunks found in freed stream!!!\n", MyStream->Stream.QStream, MyStream->Stream.Id);
  while (MyStream->FirstChunk)
  {
   FrameChunkFree(MyCon, MyStream->FirstChunk);
  }
 }
 StreamFree(MsQuic, &MyStream->Stream);

 OsRwMutexTake(MyCon->RwMtx, 1);

 if (MyStream->IsInStream)
 {
  DLLRemove(MyCon->FirstIn, MyCon->LastIn, MyStream);
 }
 else
 {
  DLLRemove(MyCon->FirstOut, MyCon->LastOut, MyStream);
 }
 MemoryZeroStruct(MyStream);
 SLLStackPush(MyCon->Free, MyStream);

 OsRwMutexDrop(MyCon->RwMtx, 1);
}

#define MyInStreamPush(MyCon) MyStreamPush(MyCon, 1)
#define MyOutStreamPush(MyCon) MyStreamPush(MyCon, 0)

static void
StreamStatsGet(QUIC_API_TABLE *MsQuic, my_stream *MyStream)
{
 QUIC_STREAM_STATISTICS Stats = {0};
 uint32_t StatsLn = sizeof(Stats);
 if (QUIC_SUCCEEDED(MsQuic->GetParam(MyStream->Stream.QStream, QUIC_PARAM_STREAM_STATISTICS, &StatsLn, &Stats)))
 {
  WtLogDebug("[CHUNK][%p][%zd][%d] HERES STATS\n", MyStream->Stream.QStream, MyStream->Stream.Id, GetCurrentThreadId());
 }
 else
 {
  WtLogDebug("[CHUNK][%p][%zd] FAILED TO GET STATS\n", MyStream->Stream.QStream, MyStream->Stream.Id);
 }
}

static uint32_t
MyStreamSendChunk(QUIC_API_TABLE *MsQuic, my_stream *MyStream, char *ArrMem, size_t ArrLn, QUIC_SEND_FLAGS Flags)
{
 uint32_t Ret = 1;
 frame_chunk *Chunk = FrameChunkPush(MyStream->MyCon, MyStream);
 Chunk->Ln = Min(ArrLn, sizeof(Chunk->Mem));
 memcpy(Chunk->Mem, ArrMem, Chunk->Ln);
 Chunk->Buf = (QUIC_BUFFER){.Buffer = Chunk->Mem, .Length = (uint32_t)Chunk->Ln};

 if (QUIC_SUCCEEDED(MsQuic->StreamSend(MyStream->Stream.QStream, &Chunk->Buf, 1, Flags, (void *)Chunk)))
 {
  WtLogDebug("[CHUNK][%p][%zd][%d] Send queued %d %zd bytes\n", MyStream->Stream.QStream, MyStream->Stream.Id, GetCurrentThreadId(), Chunk->Buf.Length, ArrLn);

  // debugging
  MyStream->SendLn += (uint32_t)ArrLn;
  if (Flags & QUIC_SEND_FLAG_FIN)
  {
   WtLogDebug("[CHUNK][%p][%zd][%d] Send Length: %d\n", MyStream->Stream.QStream, MyStream->Stream.Id, GetCurrentThreadId(), MyStream->SendLn);
  }
 }
 else
 {
  Ret = 0;
  WtLogDebug("[CHUNK][%p][%zd][%d] FAILED TO SEND\n", MyStream->Stream.QStream, MyStream->Stream.Id, GetCurrentThreadId());
 }
 return Ret;
}

static QUIC_STATUS
MyUnidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 my_stream *MyStream = Ctx;
 if (!(MyStream && MyStream->MyCon && MyStream->Stream.Con && MyStream->Stream.Con->Srv && MyStream->Stream.Con->Srv->MsQuic))
 {
  WtLogErr("[STRM] Error: Ctx missing in MyUnidiCb!\n");
  return QUIC_STATUS_SUCCESS;
 }
 frame_header_buf *FrameHeaderBuf = &MyStream->FrameHeader;
 QUIC_API_TABLE *MsQuic = MyStream->Stream.Con->Srv->MsQuic;
 WtUnidiCb(QStream, &MyStream->Stream, Event);

 // stream id is signal for header parse success
 if (Event->Type == QUIC_STREAM_EVENT_RECEIVE && MyStream->Stream.Id != UINT64_MAX)
 {
  uint32_t HasFin = !!(Event->RECEIVE.Flags & QUIC_RECEIVE_FLAG_FIN);
  uint64_t StreamType = MyStream->Stream.StreamHeader.Val1;
  if (StreamType == H3StreamUniWebtransportStream)
  {

   // buffer input
   if (!FrameHeaderIsReady(FrameHeaderBuf))
   {
    for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
    {
     QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
     uint8_t CpyLn = (uint8_t)Min(sizeof(FrameHeaderBuf->Mem) - FrameHeaderBuf->Ln, Buf->Length);
     memcpy(FrameHeaderBuf->Mem + FrameHeaderBuf->Ln, Buf->Buffer, CpyLn);
     FrameHeaderBuf->Ln += CpyLn;
     Buf->Buffer += CpyLn;
     Buf->Length -= CpyLn;
     if (FrameHeaderIsReady(FrameHeaderBuf))
     {
      break;
     }
    }
   }

   // if stream has frame id, then fan out
   if (FrameHeaderIsReady(FrameHeaderBuf))
   {
    OsRwMutexTake(MyStream->MyCon->MySrv->RwMtx, 0);
    for (my_con *MyConNode = MyStream->MyCon->MySrv->First; MyConNode; MyConNode = MyConNode->Next)
    {
     my_stream *OutStream = 0;
     if (MyConNode != MyStream->MyCon && MyConNode->Con.SessionStream && MyConNode->Con.SessionStream->Id != UINT64_MAX)
     {
      OsRwMutexTake(MyConNode->RwMtx, 1);
      // find stream with owning stream id
      size_t OutStreamLn = 0;
      for (my_stream *MyStreamNode = MyConNode->FirstOut; MyStreamNode; MyStreamNode = MyStreamNode->Next)
      {
       // cancel old streams
       if (FrameHeaderGetFrameId(&MyStreamNode->FrameHeader) < (Max(FrameHeaderGetFrameId(FrameHeaderBuf), 6) - 6))
       {
        StreamSendShutdown(MsQuic, MyStreamNode->Stream.QStream, H3ErrNoError);
       }
       else if (FrameHeaderIsReady(&MyStreamNode->FrameHeader) && MyStreamNode->OwningStreamId == MyStream->Stream.Id)
       {
        OutStream = MyStreamNode;
        OutStreamLn++;
       }
       else
       {
        OutStreamLn++;
       }
      }

      // cancel if too many streams regardless of stream id
      // this should only be run if the same stream id is being spammed for some reason
      size_t StreamCancelCnt = Max(OutStreamLn, 6) - 6;
      for (my_stream *MyStreamNode = MyConNode->LastOut; MyStreamNode && StreamCancelCnt; MyStreamNode = MyStreamNode->Prev)
      {
       StreamSendShutdown(MsQuic, MyStreamNode->Stream.QStream, H3ErrNoError);
       StreamCancelCnt--;
      }
      OsRwMutexDrop(MyConNode->RwMtx, 1);

      if (!OutStream)
      {
       // create out stream
       WtLogDebug("[STRM][%p][%zd] Creating stream\n", QStream, MyStream->Stream.Id);
       OutStream = MyOutStreamPush(MyConNode);
       OutStream->FrameHeader = *FrameHeaderBuf;
       OutStream->OwningStreamId = MyStream->Stream.Id;

       // send the frame id
       OutStream->Stream.QStream = UnidiStreamOpen(MsQuic, MyConNode->Con.QCon, MyUnidiCb, OutStream);
       if (OutStream->Stream.QStream)
       {
        uint64_t SessionId = OutStream->MyCon->Con.SessionStream->Id;
        char TmpDat[32] = {0};
        a8 UnidiHeader = A8(TmpDat, sizeof(TmpDat));
        a8 UnidiWriter = UnidiHeader;
        A8WriteVarInt(&UnidiWriter, H3StreamUniWebtransportStream);
        A8WriteVarInt(&UnidiWriter, SessionId);

        MyStreamSendChunk(MsQuic, OutStream, UnidiHeader.Mem, UnidiHeader.Ln - UnidiWriter.Ln, QUIC_SEND_FLAG_START | QUIC_SEND_FLAG_DELAY_SEND);
        MyStreamSendChunk(MsQuic, OutStream, FrameHeaderBuf->Mem, FrameHeaderBuf->Ln, QUIC_SEND_FLAG_DELAY_SEND);
       }
       else
       {
        WtLogDebug("Create stream handle failed\n");
       }
      }

      // send the buffers
      size_t BufCnt = Event->RECEIVE.BufferCount;
      frame_chunk _Chunk;
      WtLogDebug("[CHUNK][%p][%zd] Start queue chunks for stream: %zd, BufCnt: %zd\n", QStream, MyStream->Stream.Id, OutStream->Stream.Id, BufCnt);
      if (HasFin)
      {
       WtLogDebug("[CHUNK][%p][%zd][%d] Recv FIN for stream: %zd\n", QStream, MyStream->Stream.Id, GetCurrentThreadId(), OutStream->Stream.Id);
      }
      for (size_t I = 0; I < BufCnt; ++I)
      {
       QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;

       size_t Rest = Buf->Length % sizeof(_Chunk.Mem);
       size_t IterLn = Buf->Length - Rest;
       size_t BufOff = 0;
       for (; BufOff < IterLn; BufOff += sizeof(_Chunk.Mem))
       {
        QUIC_SEND_FLAGS SendFlags = QUIC_SEND_FLAG_NONE;
        if (HasFin && I == (BufCnt - 1) && !Rest && (BufOff + sizeof(_Chunk.Mem)) == IterLn)
        {
         SendFlags |= QUIC_SEND_FLAG_FIN;
         WtLogDebug("[CHUNK][%p][%zd] Assign fin flag for stream: %zd, rest: %zd iterln: %zd bufoff: %zd hasfin: %d\n", QStream, MyStream->Stream.Id, OutStream->Stream.Id, Rest, IterLn, BufOff, HasFin);
        }
        if (I < (BufCnt - 1) || Rest || (BufOff + sizeof(_Chunk.Mem)) < IterLn)
        {
         SendFlags |= QUIC_SEND_FLAG_DELAY_SEND;
        }
        
        MyStreamSendChunk(MsQuic, OutStream, Buf->Buffer + BufOff, sizeof(_Chunk.Mem), SendFlags);
       }
       if (Rest)
       {
        QUIC_SEND_FLAGS SendFlags = HasFin && I == (BufCnt - 1) ? QUIC_SEND_FLAG_FIN : QUIC_SEND_FLAG_NONE;
        MyStreamSendChunk(MsQuic, OutStream, Buf->Buffer + BufOff, Rest, SendFlags);
       }
      }

      // forward empty buffer with FIN
      // bufs can be modified so can't rely on Event->RECEIVE.TotalBufferLength
      // therefore calc totalbufln
      size_t TotalBufLn = 0;
      for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
      {
       QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
       TotalBufLn += Buf->Length;
      }
      if (!TotalBufLn && HasFin)
      {
       MyStreamSendChunk(MsQuic, OutStream, 0, 0, QUIC_SEND_FLAG_FIN);
      }
     }
    }
    OsRwMutexDrop(MyStream->MyCon->MySrv->RwMtx, 0);
   }
  }
 }
 else if (Event->Type == QUIC_STREAM_EVENT_SHUTDOWN_COMPLETE)
 {
  WtLogDebug("[STRM][%p][%zd][%d] Unidi peer stream shutdown, remotely: %d, by app: %d\n", QStream, MyStream->Stream.Id, GetCurrentThreadId(), Event->SHUTDOWN_COMPLETE.ConnectionClosedRemotely, Event->SHUTDOWN_COMPLETE.ConnectionShutdownByApp);
  MyStreamFree(MsQuic, MyStream);
 }
 else if (Event->Type == QUIC_STREAM_EVENT_SEND_COMPLETE)
 {
  frame_chunk *Chunk = Event->SEND_COMPLETE.ClientContext;
  if (Chunk)
  {
   FrameChunkFree(MyStream->MyCon, Chunk);
   WtLogDebug("[CHUNK][%p][%zd][%d] Freed chunk\n", QStream, MyStream->Stream.Id, GetCurrentThreadId());
  }
  if (Event->SEND_COMPLETE.Canceled)
  {
   WtLogDebug("[CHUNK][%p][%zd] Chunk canceled\n", QStream, MyStream->Stream.Id);
  }
 }
 else if (Event->Type == QUIC_STREAM_EVENT_PEER_SEND_ABORTED)
 {
  WtLogDebug("[STRM][%p][%zd] SEND ABORTEDSEND ABORTESEND ABORTESEND ABORTESEND ABORTEDDDD\n", QStream, MyStream->Stream.Id);
 }
 else if (Event->Type == QUIC_STREAM_EVENT_PEER_RECEIVE_ABORTED)
 {
  WtLogDebug("[STRM][%p][%zd] PEER RECEIVE ABORTED\n", QStream, MyStream->Stream.Id);
 }
 else if (Event->Type == QUIC_STREAM_EVENT_RECEIVE_BUFFER_NEEDED)
 {
  WtLogDebug("[STRM][%p][%zd] RECEIVE BUFFER NEEDED\n", QStream, MyStream->Stream.Id);
 }

 
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
MyBidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 my_stream *MyStream = Ctx;
 if (!(MyStream && MyStream->MyCon && MyStream->Stream.Con && MyStream->Stream.Con->Srv && MyStream->Stream.Con->Srv->MsQuic))
 {
  WtLogErr("[STRM] Error: Ctx missing in MyBidiCb!\n");
  return QUIC_STATUS_SUCCESS;
 }
 QUIC_API_TABLE *MsQuic = MyStream->Stream.Con->Srv->MsQuic;

 WtBidiCb(QStream, &MyStream->Stream, Event);

 if (Event->Type == QUIC_STREAM_EVENT_SHUTDOWN_COMPLETE)
 {
  WtLogDebug("[STRM][%p][%zd][%d] Bidi peer stream shutdown, remotely: %d, by app: %d\n", QStream, MyStream->Stream.Id, GetCurrentThreadId(), Event->SHUTDOWN_COMPLETE.ConnectionClosedRemotely, Event->SHUTDOWN_COMPLETE.ConnectionShutdownByApp);
  MyStreamFree(MsQuic, MyStream);
 }
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
MyConCb(HQUIC QCon, void *Ctx, QUIC_CONNECTION_EVENT *Event)
{
 my_con *MyCon = Ctx;
 my_stream *MyStream = 0;
 if (Event->Type == QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED)
 {
  MyStream = MyInStreamPush(MyCon);
 }

 WtConCb(QCon, (void *)&MyCon->Con, Event, (void *)MyUnidiCb, (void *)MyBidiCb, (void *)MyStream);

 if (Event->Type == QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE)
 {
  WtLogDebug("[CON] Freeing connection\n");
  MyConFree(MyCon);
 }
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
MyListenCb(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event)
{
 my_srv *MySrv = Ctx;
 my_con *MyConCbCtx = 0;
 if (Event->Type == QUIC_LISTENER_EVENT_NEW_CONNECTION)
 {
  MyConCbCtx = MyConAlloc(MySrv);
 }
 return WtListenCb(Listener, &MySrv->Srv, Event, (void *)MyConCb, (void *)MyConCbCtx);
}

int
main(int argc, char* argv[])
{
 OsInit(&OS_W32State);

 my_srv *MySrv = MySrvAlloc();
 if (MySrv)
 {
  WtListen(&MySrv->Srv, 4567, MyListenCb, (void *)MySrv);
  WtLogDebug("Press Enter to exit.\n\n");
  (void)getchar();
 }

 // release mysrv and srv
 OsRwMutexRelease(MySrv->RwMtx);
 WtClose(&MySrv->Srv);

 return 0;

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

 //  WtLogDebug("Done lalal\n");
 // }
}