#include "wt.c"

static QUIC_STATUS
MyUnidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 wt_stream *Stream = (wt_stream *)Ctx;
 QUIC_API_TABLE *MsQuic = Stream->Con->Srv->MsQuic;
 WtUnidiCb(QStream, Ctx, Event);

 // stream id is signal for header parse success
 if (Stream->Id != UINT64_MAX)
 {
  uint64_t StreamType = Stream->StreamHeader.Val1;
  if (StreamType == H3StreamUniWebtransportStream)
  {
   // todo forward this stream to all other connections
   
   // StreamPush()
  }
 }
 
 return QUIC_STATUS_SUCCESS;
}

static QUIC_STATUS
MyBidiCb(HQUIC QStream, void *Ctx, QUIC_STREAM_EVENT *Event)
{
 return WtBidiCb(QStream, Ctx, Event);
}

static QUIC_STATUS
MyConCb(HQUIC QCon, void *Ctx, QUIC_CONNECTION_EVENT *Event)
{
 return WtConCb(QCon, Ctx, Event, (void *)MyUnidiCb, (void *)MyBidiCb);
}

static QUIC_STATUS
MyListenCb(HQUIC Listener, void *Ctx, QUIC_LISTENER_EVENT *Event)
{
 return WtListenCb(Listener, Ctx, Event, (void *)MyConCb);
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