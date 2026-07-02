#include "cbase.h"
#include "ov_ipc.h"

#include <string.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib") // auto-link Winsock (MSVC/clang-cl)
typedef int socklen_t;
#define OVIPC_INVALID INVALID_SOCKET
#define ovipc_close closesocket
static bool s_wsaInit = false;
static void OVIPC_PlatformInit()
{
    if ( !s_wsaInit ) { WSADATA w; WSAStartup( MAKEWORD( 2, 2 ), &w ); s_wsaInit = true; }
}
static bool OVIPC_WouldBlock() { return WSAGetLastError() == WSAEWOULDBLOCK; }
static void OVIPC_SetNonBlocking( int s ) { u_long m = 1; ioctlsocket( s, FIONBIO, &m ); }
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#define OVIPC_INVALID (-1)
#define ovipc_close ::close
static void OVIPC_PlatformInit() {}
static bool OVIPC_WouldBlock() { return errno == EWOULDBLOCK || errno == EAGAIN; }
static void OVIPC_SetNonBlocking( int s ) { int f = fcntl( s, F_GETFL, 0 ); fcntl( s, F_SETFL, f | O_NONBLOCK ); }
#endif

#include "tier0/memdbgon.h"

COpenVibeIPC::COpenVibeIPC()
    : m_nPort( 0 ), m_LineCb( NULL ), m_Socket( OVIPC_INVALID ),
      m_flNextReconnect( 0.0 ), m_RxLen( 0 )
{
    m_szHost[0] = '\0';
    OVIPC_PlatformInit();
}

COpenVibeIPC::~COpenVibeIPC()
{
    Close();
}

void COpenVibeIPC::Configure( const char *pszHost, int nPort, LineFn lineCb )
{
    Q_strncpy( m_szHost, pszHost && pszHost[0] ? pszHost : "127.0.0.1", sizeof( m_szHost ) );
    m_nPort = nPort;
    m_LineCb = lineCb;
}

bool COpenVibeIPC::IsConnected() const
{
    return m_Socket != OVIPC_INVALID;
}

void COpenVibeIPC::Close()
{
    if ( m_Socket != OVIPC_INVALID )
    {
        ovipc_close( m_Socket );
        m_Socket = OVIPC_INVALID;
    }
    m_RxLen = 0;
}

bool COpenVibeIPC::TryConnect()
{
    if ( m_nPort <= 0 ) return false;

    int s = (int)socket( AF_INET, SOCK_STREAM, IPPROTO_TCP );
    if ( s == OVIPC_INVALID ) return false;

    struct sockaddr_in addr;
    memset( &addr, 0, sizeof( addr ) );
    addr.sin_family = AF_INET;
    addr.sin_port = htons( (unsigned short)m_nPort );
    addr.sin_addr.s_addr = inet_addr( m_szHost );

    // Blocking connect to localhost is effectively instant; then go non-blocking.
    if ( connect( s, (struct sockaddr *)&addr, sizeof( addr ) ) != 0 )
    {
        ovipc_close( s );
        return false;
    }

    int one = 1;
    setsockopt( s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof( one ) );
    OVIPC_SetNonBlocking( s );

    m_Socket = s;
    m_RxLen = 0;
    return true;
}

bool COpenVibeIPC::SendLine( const char *pszJson )
{
    if ( !pszJson ) return false;
    if ( m_Socket == OVIPC_INVALID ) return false;

    int len = Q_strlen( pszJson );
    bool needNL = ( len == 0 || pszJson[len - 1] != '\n' );

    // Blocking-ish send to localhost; small messages. On error, drop + close.
    int sent = send( m_Socket, pszJson, len, 0 );
    if ( sent < 0 ) { if ( !OVIPC_WouldBlock() ) Close(); return false; }
    if ( needNL ) send( m_Socket, "\n", 1, 0 );
    return true;
}

void COpenVibeIPC::Poll()
{
    if ( m_Socket == OVIPC_INVALID )
    {
        double now = Plat_FloatTime();
        if ( now < m_flNextReconnect ) return;
        m_flNextReconnect = now + 2.0; // retry every 2s
        if ( !TryConnect() ) return;
    }

    for (;;)
    {
        int space = (int)sizeof( m_RxBuf ) - 1 - m_RxLen;
        if ( space <= 0 ) { m_RxLen = 0; space = (int)sizeof( m_RxBuf ) - 1; } // overflow guard
        int n = recv( m_Socket, m_RxBuf + m_RxLen, space, 0 );
        if ( n == 0 ) { Close(); return; }            // peer closed
        if ( n < 0 ) { if ( !OVIPC_WouldBlock() ) Close(); break; }
        m_RxLen += n;
        m_RxBuf[m_RxLen] = '\0';

        // Dispatch complete lines.
        int start = 0;
        for ( int i = 0; i < m_RxLen; ++i )
        {
            if ( m_RxBuf[i] == '\n' )
            {
                m_RxBuf[i] = '\0';
                if ( m_LineCb && i > start ) m_LineCb( m_RxBuf + start );
                start = i + 1;
            }
        }
        if ( start > 0 )
        {
            m_RxLen -= start;
            memmove( m_RxBuf, m_RxBuf + start, m_RxLen );
        }
        if ( n < space ) break; // drained
    }
}
