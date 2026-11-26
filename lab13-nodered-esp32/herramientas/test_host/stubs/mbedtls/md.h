#pragma once
// mbedtls de ESP32 sustituido por OpenSSL (solo pruebas en PC)
#include <openssl/hmac.h>
#include <openssl/evp.h>
typedef int mbedtls_md_info_t;
#define MBEDTLS_MD_SHA256 1
inline const mbedtls_md_info_t* mbedtls_md_info_from_type(int) { static int x; return &x; }
inline int mbedtls_md_hmac(const mbedtls_md_info_t*, const uint8_t* k, size_t kl, const uint8_t* m, size_t ml, uint8_t* o) { unsigned l; HMAC(EVP_sha256(), k, (int)kl, m, ml, o, &l); return 0; }
