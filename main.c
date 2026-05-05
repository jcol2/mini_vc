#include "wt.c"

typedef struct frame_header frame_header;
struct frame_header
{
 uint32_t TrackId;
 uint64_t FrameId;
};

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
 frame_header_buf FrameHeader;
 // uint64_t TimeStamp;
 // uint64_t SequenceNumber;
 // uint8_t Flags;

 wt_stream Stream;

 my_con *MyCon;
 my_stream *Next;
 my_stream *Prev;

 frame_chunk *FirstChunk;
 frame_chunk *LastChunk;
};

#define FrameHeaderIsReady(U64Buf) ((U64Buf)->Ln == sizeof((U64Buf)->Mem))

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
 OsRwMutexTake(MyCon->MySrv->RwMtx, 1);
 DLLRemove(MyCon->MySrv->First, MyCon->MySrv->Last, MyCon);
 OsRwMutexDrop(MyCon->MySrv->RwMtx, 1);

 OsRwMutexRelease(MyCon->RwMtx);
 ConFree(&MyCon->Con);
 ArRelease(MyCon->Ar);
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
MyStreamFree(my_stream *MyStream)
{
 my_con *MyCon = MyStream->MyCon;
 StreamFree(&MyStream->Stream);

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

static frame_chunk *
FrameChunkPush(my_con *MyCon, my_stream *MyStream)
{
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

static uint32_t
MyStreamSendChunk(QUIC_API_TABLE *MsQuic, my_stream *MyStream, char *ArrMem, size_t ArrLn, QUIC_SEND_FLAGS Flags)
{
 uint32_t Ret = 1;
 frame_chunk *Chunk = FrameChunkPush(MyStream->MyCon, MyStream);
 Chunk->Ln = Min(ArrLn, sizeof(Chunk->Mem));
 memcpy(Chunk->Mem, ArrMem, Chunk->Ln);
 Chunk->Buf = (QUIC_BUFFER){.Buffer = Chunk->Mem, .Length = (uint32_t)Chunk->Ln};
 if (QUIC_FAILED(MsQuic->StreamSend(MyStream->Stream.QStream, &Chunk->Buf, 1, Flags, (void *)Chunk)))
 {
  Ret = 0;
  printf("[CHUNK] Send failed\n");
 }
 return Ret;
}

static QUIC_STATUS
MyUnidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 my_stream *MyStream = Ctx;
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
    for (my_con *MyConNode = MyStream->MyCon->MySrv->First; MyConNode; MyConNode = MyConNode->Next)
    {
     // todo only send when not this connection
     // if (MyConNode != MyStream->MyCon)
     {
      // find stream with FrameId
      my_stream *OutStream = 0;
      for (my_stream *MyStreamNode = MyConNode->FirstOut; MyStreamNode; MyStreamNode = MyStreamNode->Next)
      {
       if (FrameHeaderIsReady(&MyStreamNode->FrameHeader) && MyStreamNode->FrameHeader.Header.FrameId == FrameHeaderBuf->Header.FrameId)
       {
        OutStream = MyStreamNode;
        break;
       }
      }

      if (!OutStream)
      {
       OutStream = MyOutStreamPush(MyConNode);

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

        MyStreamSendChunk(MsQuic, OutStream, UnidiHeader.Mem, UnidiHeader.Ln - UnidiWriter.Ln, QUIC_SEND_FLAG_NONE);
        MyStreamSendChunk(MsQuic, OutStream, FrameHeaderBuf->Mem, FrameHeaderBuf->Ln, QUIC_SEND_FLAG_NONE);
       }
       else
       {
        printf("Create stream handle failed\n");
       }
      }

      // send the buffers
      QUIC_SEND_FLAGS SendFlags = HasFin ? QUIC_SEND_FLAG_FIN : QUIC_SEND_FLAG_NONE;
      for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
      {
       QUIC_BUFFER *Buf = (QUIC_BUFFER *)Event->RECEIVE.Buffers + I;
       MyStreamSendChunk(MsQuic, OutStream, Buf->Buffer, Buf->Length, SendFlags);
      }
     }
    }
   }
  }
 }
 else if (Event->Type == QUIC_STREAM_EVENT_SHUTDOWN_COMPLETE)
 {
  printf("[STRM] Peer stream shutdown\n");
  MyStreamFree(MyStream);
 }
 else if (Event->Type == QUIC_STREAM_EVENT_SEND_COMPLETE)
 {
  frame_chunk *Chunk = Event->SEND_COMPLETE.ClientContext;
  FrameChunkFree(MyStream->MyCon, Chunk);
  printf("[CHUNK] Freed chunk\n");
 }
 
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
MyBidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 my_stream *MyStream = Ctx;
 
 WtBidiCb(QStream, &MyStream->Stream, Event);

 if (Event->RECEIVE.Flags & QUIC_RECEIVE_FLAG_FIN)
 {
  MyStreamFree(MyStream);
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
  WtConCb(QCon, (void *)&MyCon->Con, Event, (void *)MyUnidiCb, (void *)MyBidiCb, (void *)MyStream);
 }
 else if (Event->Type == QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE)
 {
  WtConCb(QCon, (void *)&MyCon->Con, Event, (void *)MyUnidiCb, (void *)MyBidiCb, (void *)MyStream);
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
  printf("Press Enter to exit.\n\n");
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

 //  printf("Done lalal\n");
 // }
}