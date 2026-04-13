#define _CRT_SECURE_NO_WARNINGS 1

#define QUIC_API_ENABLE_PREVIEW_FEATURES 1

#ifdef _WIN32
//
// The conformant preprocessor along with the newest SDK throws this warning for
// a macro in C mode. As users might run into this exact bug, exclude this
// warning here. This is not an MsQuic bug but a Windows SDK bug.
//
#pragma warning(disable:5105)
#include <share.h>
#endif
#include "msquic.h"
#include <stdio.h>
#include <stdlib.h>

// The (optional) registration configuration for the app. This sets a name for
// the app (used for persistent storage and for debugging). It also configures
// the execution profile, using the default "low latency" profile.
const QUIC_REGISTRATION_CONFIG RegConfig = { "quicsample", QUIC_EXECUTION_PROFILE_LOW_LATENCY };

// The protocol name used in the Application Layer Protocol Negotiation (ALPN).
const QUIC_BUFFER Alpn = { sizeof("sample") - 1, (uint8_t*)"sample" };

const uint16_t UdpPort = 4567;

// The default idle timeout period (1 second) used for the protocol.
const uint64_t IdleTimeoutMs = 1000;

// The length of buffer sent over the streams in the protocol.
const uint32_t SendBufferLength = 100;

const QUIC_API_TABLE* MsQuic;
HQUIC Registration;
HQUIC Configuration;


// The struct to be filled with TLS secrets
// for debugging packet captured with e.g. Wireshark.
QUIC_TLS_SECRETS ClientSecrets = {0};

// The name of the environment variable being
// used to get the path to the ssl key log file.
const char* SslKeyLogEnvVar = "SSLKEYLOGFILE";


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


 if (MsQuic != NULL) {
  if (Configuration != NULL) {
   MsQuic->ConfigurationClose(Configuration);
  }
  if (Registration != NULL) {
   //
   // This will block until all outstanding child objects have been
   // closed.
   //
   MsQuic->RegistrationClose(Registration);
  }
  MsQuicClose(MsQuic);
 }

 return (int)Status;
}