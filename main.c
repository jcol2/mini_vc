#include "wt.c"

typedef struct u64_buf u64_buf;
struct u64_buf
{
 union
 {
  uint8_t Mem[sizeof(uint64_t)];
  uint64_t Val;
 };
 uint8_t Ln;
};

typedef struct my_con my_con;
typedef struct my_stream my_stream;

struct my_stream
{
 u64_buf FrameId;
 // uint64_t TimeStamp;
 // uint64_t SequenceNumber;
 // uint8_t Flags;

 wt_stream Stream;

 my_con *MyCon;
 my_stream *Next;
 my_stream *Prev;
};

struct my_con
{
 rw_mtx RwMtx;
 my_stream *First;
 my_stream *Last;
 my_stream *Free;

 wt_con Con;
};

static my_con *
MyConAlloc(wt_server *Srv)
{
 ar *Ar = ArAlloc();
 my_con *MyCon = ArPush(Ar, my_con, 1);
 MyCon->RwMtx = OsRwMutexAlloc();
 ConAlloc(Srv, &MyCon->Con, Ar);
 return MyCon;
}

static void
MyConFree(my_con *MyCon)
{
 OsRwMutexRelease(MyCon->RwMtx);
 ConFree(&MyCon->Con);
}

static my_stream *
MyStreamPush(my_con *MyCon)
{
 OsRwMutexTake(MyCon->RwMtx, 1);

 my_stream *MyStream = MyCon->Free;
 if (MyStream)
 {
  SLLStackPop(MyCon->Free);
 }
 else
 {
  MyStream = ArPush(MyCon->Con.Ar, my_stream, 1);
 }
 MyStream->MyCon = MyCon;
 DLLPushFront(MyCon->First, MyCon->Last, MyStream);

 OsRwMutexDrop(MyCon->RwMtx, 1);
 return MyStream;
}

static void
MyStreamFree(my_stream *MyStream)
{
 StreamFree(&MyStream->Stream);

 OsRwMutexTake(MyStream->MyCon->RwMtx, 1);
 SLLStackPush(MyStream->MyCon->Free, MyStream);
 OsRwMutexDrop(MyStream->MyCon->RwMtx, 1);

 MemoryZeroStruct(MyStream);
}

static QUIC_STATUS
MyUnidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 my_stream *MyStream = Ctx;
 u64_buf *FrameId = &MyStream->FrameId;
 QUIC_API_TABLE *MsQuic = MyStream->Stream.Con->Srv->MsQuic;
 WtUnidiCb(QStream, Ctx, Event);

 // stream id is signal for header parse success
 if (Event->Type == QUIC_STREAM_EVENT_RECEIVE && MyStream->Stream.Id != UINT64_MAX)
 {
  uint64_t StreamType = MyStream->Stream.StreamHeader.Val1;
  if (StreamType == H3StreamUniWebtransportStream)
  {
   for (size_t I = 0; I < Event->RECEIVE.BufferCount; ++I)
   {
    QUIC_BUFFER Buf = Event->RECEIVE.Buffers[I];
    uint8_t CpyLn = (uint8_t)Min(sizeof(FrameId->Mem) - FrameId->Ln, Buf.Length);
    memcpy(FrameId->Mem + FrameId->Ln, Buf.Buffer, CpyLn);
    FrameId->Ln += CpyLn;
    if (FrameId->Ln == sizeof(FrameId->Mem))
    {
     break;
    }
   }
   // todo buffer frame id
   // todo if stream has frame id, then fan out
   if (FrameId->Ln == sizeof(FrameId->Mem))
   {
    for (wt_con *ConNode = MyStream->Stream.Con->Srv->First; ConNode; ConNode = ConNode->Next)
    {
     ConNode->FirstStream;
     // todo map this stream to an outgoing stream
    }
   }
  }
 }

 if (Event->RECEIVE.Flags & QUIC_RECEIVE_FLAG_FIN)
 {
  MyStreamFree(MyStream);
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
  MyStream = MyStreamPush(MyCon);
 }
 else if (Event->Type == QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE)
 {
  MyConFree(MyCon);
 }
 return WtConCb(QCon, (void *)&MyCon->Con, Event, (void *)MyUnidiCb, (void *)MyBidiCb, (void *)MyStream);
}

static QUIC_STATUS
MyListenCb(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event)
{
 wt_server *Srv = Ctx;
 my_con *MyConCbCtx = 0;
 if (Event->Type == QUIC_LISTENER_EVENT_NEW_CONNECTION)
 {
  MyConCbCtx = MyConAlloc(Srv);
 }
 return WtListenCb(Listener, Ctx, Event, (void *)MyConCb, (void *)MyConCbCtx);
}

int
main(int argc, char* argv[])
{
 OsInit(&OS_W32State);
 ar *Ar = ArAlloc();
 wt_server *Srv = WtInit(Ar);

 if (Srv)
 {
  WtListen(Srv, 4567, MyListenCb);
  printf("Press Enter to exit.\n\n");
  (void)getchar();
 }

 WtClose(Srv);

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