#ifndef OV_IPC_H
#define OV_IPC_H
#ifdef _WIN32
#pragma once
#endif

// Minimal cross-platform, non-blocking, line-delimited TCP client used to bridge
// the Source game DLLs to the OpenVibe Node.js runtime host (ov-runtime.js).
// Each realm connects to its runtime port (server 41999, client 41998), sends
// newline-terminated JSON messages, and polls for inbound newline-terminated
// JSON which it hands to a line callback. Auto-reconnects when the runtime isn't
// up yet. No JSON parsing here — callers build/parse the JSON.
class COpenVibeIPC
{
public:
    typedef void (*LineFn)( const char *pszLine );

    COpenVibeIPC();
    ~COpenVibeIPC();

    // host is usually "127.0.0.1". lineCb is invoked (during Poll) per inbound line.
    void Configure( const char *pszHost, int nPort, LineFn lineCb );

    bool IsConnected() const;
    // Send one message; a trailing '\n' is added if missing. Returns false if not
    // connected (message dropped). Attempts a (throttled) reconnect if needed.
    bool SendLine( const char *pszJson );
    // Pump: attempt reconnect if down, read available bytes, dispatch full lines.
    // Call every frame/tick.
    void Poll();
    void Close();

private:
    bool TryConnect();

    char   m_szHost[64];
    int    m_nPort;
    LineFn m_LineCb;
    int    m_Socket;          // -1 when not connected
    double m_flNextReconnect; // throttle
    char   m_RxBuf[65536];
    int    m_RxLen;
};

#endif // OV_IPC_H
