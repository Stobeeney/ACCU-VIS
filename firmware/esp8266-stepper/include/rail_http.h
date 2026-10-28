// Tiny, allocation-free HTTP/1.x response parser for the rail's cloud client.
//
// Fed one byte at a time (so it can run from loop() without ever blocking the
// stepper) and handles the three ways a server can frame a body:
//   * Content-Length            (what Vercel/Flask send for our small JSON)
//   * Transfer-Encoding: chunked
//   * neither: body runs until the server closes the connection (the local
//     python http.server used for bench tests does this)
//
// No Arduino dependencies, so the same code can be tested anywhere; on the
// board, httpParserSelfTest() runs a few canned responses at boot (see
// RAIL_HTTP_SELFTEST in rail_config.h) and prints PASS/FAIL to the serial port.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct HttpResponse {
  enum Phase : uint8_t {
    STATUS_LINE, HEADERS, BODY_FIXED, CHUNK_SIZE, CHUNK_DATA, CHUNK_CRLF,
    CHUNK_TRAILER, BODY_UNTIL_CLOSE, DONE, ERROR
  };

  static const size_t BODY_MAX = 1536;
  static const size_t LINE_MAX = 120;

  Phase phase;
  int status;
  bool keepAlive;
  bool chunked;
  long contentLength;   // -1 = not given
  size_t bodyLen;
  char body[BODY_MAX + 1];

  char line[LINE_MAX + 1];
  size_t lineLen;
  long chunkRemaining;

  HttpResponse() { reset(); }

  void reset() {
    phase = STATUS_LINE;
    status = 0;
    keepAlive = false;
    chunked = false;
    contentLength = -1;
    bodyLen = 0;
    body[0] = '\0';
    lineLen = 0;
    chunkRemaining = 0;
  }

  bool done() const { return phase == DONE; }
  bool failed() const { return phase == ERROR; }

  // The peer closed the connection: that legitimately ends an "until close" body.
  void onClose() {
    if (phase == BODY_UNTIL_CLOSE) phase = DONE;
    else if (phase != DONE) phase = ERROR;
  }

  void feed(char c) {
    switch (phase) {
      case STATUS_LINE:
      case HEADERS:
      case CHUNK_SIZE:
      case CHUNK_TRAILER:
        feedLine(c);
        break;
      case BODY_FIXED:
        if (!store(c)) return;
        if ((long)bodyLen >= contentLength) phase = DONE;
        break;
      case BODY_UNTIL_CLOSE:
        store(c);
        break;
      case CHUNK_DATA:
        if (!store(c)) return;
        if (--chunkRemaining <= 0) phase = CHUNK_CRLF;
        break;
      case CHUNK_CRLF:
        if (c == '\n') phase = CHUNK_SIZE;
        else if (c != '\r') phase = ERROR;
        break;
      default:
        break;
    }
  }

  void feed(const char *data, size_t n) {
    for (size_t i = 0; i < n && phase != DONE && phase != ERROR; i++) feed(data[i]);
  }

private:
  bool store(char c) {
    if (bodyLen >= BODY_MAX) { phase = ERROR; return false; }
    body[bodyLen++] = c;
    body[bodyLen] = '\0';
    return true;
  }

  static bool startsWithNoCase(const char *s, const char *prefix) {
    for (; *prefix; s++, prefix++) {
      char a = *s, b = *prefix;
      if (a >= 'A' && a <= 'Z') a += 32;
      if (b >= 'A' && b <= 'Z') b += 32;
      if (a != b) return false;
    }
    return true;
  }

  static bool containsNoCase(const char *s, const char *needle) {
    size_t n = strlen(needle);
    for (; *s; s++) if (startsWithNoCase(s, needle)) return true;
    return n == 0;
  }

  void feedLine(char c) {
    if (c == '\r') return;
    if (c != '\n') {
      if (lineLen < LINE_MAX) line[lineLen++] = c;   // overlong header lines are truncated, not fatal
      return;
    }
    line[lineLen] = '\0';
    size_t len = lineLen;
    lineLen = 0;
    handleLine(len);
  }

  void handleLine(size_t len) {
    switch (phase) {
      case STATUS_LINE: {
        // "HTTP/1.1 200 OK"
        if (len < 12 || !startsWithNoCase(line, "http/1.")) { phase = ERROR; return; }
        keepAlive = (line[7] == '1');                 // HTTP/1.1 defaults to keep-alive
        const char *sp = strchr(line, ' ');
        status = sp ? atoi(sp + 1) : 0;
        if (status < 100 || status > 599) { phase = ERROR; return; }
        phase = HEADERS;
        break;
      }
      case HEADERS:
        if (len == 0) { endOfHeaders(); return; }
        if (startsWithNoCase(line, "content-length:")) contentLength = atol(line + 15);
        else if (startsWithNoCase(line, "transfer-encoding:") && containsNoCase(line, "chunked")) chunked = true;
        else if (startsWithNoCase(line, "connection:")) {
          if (containsNoCase(line, "close")) keepAlive = false;
          else if (containsNoCase(line, "keep-alive")) keepAlive = true;
        }
        break;
      case CHUNK_SIZE: {
        long size = strtol(line, nullptr, 16);       // ignores ";extensions" after the number
        if (size < 0) { phase = ERROR; return; }
        if (size == 0) phase = CHUNK_TRAILER;
        else { chunkRemaining = size; phase = CHUNK_DATA; }
        break;
      }
      case CHUNK_TRAILER:
        if (len == 0) phase = DONE;                  // blank line ends the trailers
        break;
      default:
        break;
    }
  }

  void endOfHeaders() {
    if (status == 204 || status == 304 || (status >= 100 && status < 200)) { phase = DONE; return; }
    if (chunked) { phase = CHUNK_SIZE; return; }
    if (contentLength == 0) { phase = DONE; return; }
    if (contentLength > 0) {
      if (contentLength > (long)BODY_MAX) { phase = ERROR; return; }
      phase = BODY_FIXED;
      return;
    }
    keepAlive = false;                                // no length: the body ends when the server closes
    phase = BODY_UNTIL_CLOSE;
  }
};

// ---- on-board self-test -------------------------------------------------------------------
// Returns the number of failed checks (0 = all passed). `report` is called with a line of text.
typedef void (*HttpTestReport)(const char *line);

inline int httpParserSelfTest(HttpTestReport report) {
  int failures = 0;
  static HttpResponse r;   // static: keeps ~1.7 KB off the stack
  char msg[96];

  auto check = [&](const char *name, bool ok) {
    if (!ok) failures++;
    snprintf(msg, sizeof(msg), "  %s  %s", ok ? "PASS" : "FAIL", name);
    report(msg);
  };

  // 1. Content-Length, delivered in tiny pieces (as a slow network would)
  {
    const char *s = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
    r.reset();
    for (const char *p = s; *p; p++) r.feed(*p);
    check("content-length body", r.done() && r.status == 200 && r.keepAlive && strcmp(r.body, "{\"ok\":true}") == 0);
  }
  // 2. chunked, with a chunk extension and a trailer
  {
    const char *s = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6;x=1\r\n{\"ok\":\r\n5\r\ntrue}\r\n0\r\nX-T: 1\r\n\r\n";
    r.reset();
    r.feed(s, strlen(s));
    check("chunked body", r.done() && strcmp(r.body, "{\"ok\":true}") == 0 && r.keepAlive);
  }
  // 3. no length: body ends when the server closes (python http.server, HTTP/1.0)
  {
    const char *s = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
    r.reset();
    r.feed(s, strlen(s));
    bool beforeClose = r.done();
    r.onClose();
    check("body until close", !beforeClose && r.done() && !r.keepAlive && strcmp(r.body, "{\"ok\":true}") == 0);
  }
  // 4. errors and edge cases
  {
    const char *s = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    r.reset();
    r.feed(s, strlen(s));
    check("401 with Connection: close", r.done() && r.status == 401 && !r.keepAlive);

    r.reset();
    const char *garbage = "garbage not http\r\n";
    r.reset();
    r.feed(garbage, strlen(garbage));
    check("rejects non-HTTP", r.failed());

    const char *big = "HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n";
    r.reset();
    r.feed(big, strlen(big));
    check("rejects oversized body", r.failed());

    const char *noContent = "HTTP/1.1 204 No Content\r\n\r\n";
    r.reset();
    r.feed(noContent, strlen(noContent));
    check("204 has no body", r.done() && r.bodyLen == 0);

    const char *truncated = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc";
    r.reset();
    r.feed(truncated, strlen(truncated));
    r.onClose();
    check("truncated body is an error", r.failed());
  }
  return failures;
}
