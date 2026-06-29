/**
 * OpenVibe.JS ↔ C++ Bridge
 * 
 * This file demonstrates how to integrate OpenVibe.JS with the Source engine C++ code.
 * 
 * OPTION 1: V8 Direct Bindings
 * - C++ loads Node.js runtime directly
 * - Direct function calls between C++ and JS
 * - Best performance, most complex
 * 
 * OPTION 2: IPC Socket/Pipe
 * - Node.js runs in separate process
 * - JSON messaging over socket/named pipe
 * - Good isolation, simpler integration
 * 
 * OPTION 3: Child Process with stdio
 * - Node.js spawned as child process
 * - Parent (C++) communicates via stdin/stdout
 * - Easiest to implement
 * 
 * This file provides TYPE DEFINITIONS and EXAMPLES for each approach.
 */

/**
 * TYPE DEFINITIONS
 * These define the message formats between C++ and Node.js
 */

/**
 * Message from C++ to Node.js
 */
interface CppToNodeMessage {
  type:
    | 'init'
    | 'player_join'
    | 'player_leave'
    | 'player_death'
    | 'command'
    | 'tick';
  data: Record<string, any>;
}

/**
 * Example messages:
 *
 * // Player joined
 * { type: 'player_join', data: { steamId: '76561198123456789', name: 'Player' } }
 *
 * // Player left
 * { type: 'player_leave', data: { steamId: '76561198123456789' } }
 *
 * // Player died
 * { type: 'player_death', data: { deadSteamId: '...', killerSteamId: '...' } }
 *
 * // Execute gamemode command
 * { type: 'command', data: { cmd: 'ov_gamemode_start hub' } }
 *
 * // Game tick (30Hz default)
 * { type: 'tick', data: {} }
 */

/**
 * Message from Node.js to C++
 */
interface NodeToCppMessage {
  type:
    | 'ready'
    | 'gamemode_loaded'
    | 'gamemode_started'
    | 'entity_spawn'
    | 'entity_remove'
    | 'entity_update'
    | 'broadcast'
    | 'team_message'
    | 'error';
  data: Record<string, any>;
}

/**
 * Example messages:
 *
 * // Runtime ready
 * { type: 'ready', data: {} }
 *
 * // Gamemode loaded
 * { type: 'gamemode_loaded', data: { name: 'Hub', version: '1.0.0' } }
 *
 * // Spawn entity
 * { type: 'entity_spawn', data: { type: 'prop', model: '...', pos: {x, y, z} } }
 *
 * // Broadcast message
 * { type: 'broadcast', data: { message: '...' } }
 *
 * // Error
 * { type: 'error', data: { error: '...', stack: '...' } }
 */

/**
 * IMPLEMENTATION EXAMPLE: IPC Socket Bridge
 *
 * This is the recommended approach for initial integration.
 * C++ spawns Node.js with a Unix socket, communicates via JSON messages.
 */

const net = require('net');
const { runtime } = require('./index');

class OpenVibeJsBridge {
  constructor(socketPath = '/tmp/openvibe-js.sock') {
    this.socketPath = socketPath;
    this.server = null;
    this.client = null;
  }

  /**
   * Start the bridge server (listening for C++ connections)
   */
  startServer() {
    // Remove existing socket file
    try {
      require('fs').unlinkSync(this.socketPath);
    } catch (e) {}

    this.server = net.createServer((socket) => {
      console.log('[Bridge] C++ client connected');
      this.client = socket;

      socket.setEncoding('utf8');

      socket.on('data', (data) => {
        this.handleMessage(JSON.parse(data));
      });

      socket.on('end', () => {
        console.log('[Bridge] C++ client disconnected');
        this.client = null;
      });

      socket.on('error', (err) => {
        console.error('[Bridge] Socket error:', err);
      });

      // Send ready message
      this.sendMessage({
        type: 'ready',
        data: { version: '1.0.0', gamemodes: runtime.listGamemodes() },
      });
    });

    this.server.listen(this.socketPath, () => {
      console.log(`[Bridge] Listening on ${this.socketPath}`);
    });
  }

  /**
   * Handle incoming message from C++
   */
  handleMessage(msg) {
    const { type, data } = msg;

    console.log(`[Bridge] Received: ${type}`);

    switch (type) {
      case 'init':
        runtime.initialize();
        break;

      case 'player_join':
        const player = runtime.onPlayerJoin(data.steamId, data.name);
        this.sendMessage({
          type: 'player_joined',
          data: { steamId: data.steamId, name: data.name },
        });
        break;

      case 'player_leave':
        runtime.onPlayerLeave(data.steamId);
        break;

      case 'player_death':
        runtime.onPlayerDeath(data.deadSteamId, data.killerSteamId);
        break;

      case 'command':
        runtime.executeCommand(data.cmd);
        break;

      case 'tick':
        // Called periodically from C++ (e.g., 30Hz)
        // Gamemodes can use this for their think functions
        break;

      default:
        console.warn(`[Bridge] Unknown message type: ${type}`);
    }
  }

  /**
   * Send message to C++
   */
  sendMessage(msg) {
    if (this.client) {
      this.client.write(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Broadcast message (from gamemode to C++)
   */
  broadcast(message) {
    this.sendMessage({ type: 'broadcast', data: { message } });
  }

  /**
   * Spawn entity (from gamemode to C++)
   */
  spawnEntity(type, modelOrData, pos) {
    this.sendMessage({
      type: 'entity_spawn',
      data: { type, model: modelOrData, pos },
    });
  }
}

// Export bridge
module.exports = OpenVibeJsBridge;

/**
 * C++ INTEGRATION PSEUDO-CODE
 *
 * In your Source plugin (e.g., openvibe_server.cpp):
 *
 * ```cpp
 * #include <winsock2.h> // or sys/socket.h on Linux
 * #include <json.hpp>
 *
 * class COpenVibeJsClient {
 * private:
 *     SOCKET socketFd;
 *     std::string socketPath; // /tmp/openvibe-js.sock
 *
 * public:
 *     bool Connect() {
 *         // Create Unix socket connection to Node.js
 *         socketFd = socket(AF_UNIX, SOCK_STREAM, 0);
 *         sockaddr_un addr;
 *         addr.sun_family = AF_UNIX;
 *         strcpy(addr.sun_path, socketPath.c_str());
 *
 *         return connect(socketFd, (sockaddr*)&addr, sizeof(addr)) == 0;
 *     }
 *
 *     void SendMessage(const nlohmann::json& msg) {
 *         std::string jsonStr = msg.dump();
 *         send(socketFd, jsonStr.c_str(), jsonStr.length(), 0);
 *         send(socketFd, "\n", 1, 0);
 *     }
 *
 *     void OnPlayerConnect(const char* steamId, const char* name) {
 *         nlohmann::json msg;
 *         msg["type"] = "player_join";
 *         msg["data"]["steamId"] = steamId;
 *         msg["data"]["name"] = name;
 *         SendMessage(msg);
 *     }
 *
 *     void OnPlayerDisconnect(const char* steamId) {
 *         nlohmann::json msg;
 *         msg["type"] = "player_leave";
 *         msg["data"]["steamId"] = steamId;
 *         SendMessage(msg);
 *     }
 * };
 *
 * // Global instance
 * COpenVibeJsClient g_JsClient;
 *
 * // Hook into player connect/disconnect
 * void OnPlayerConnect(IGamePlayer* player) {
 *     g_JsClient.OnPlayerConnect(
 *         player->GetSteamID64String(),
 *         player->GetName()
 *     );
 * }
 * ```
 */

/**
 * LAUNCHING NODE.JS FROM SOURCE PLUGIN
 *
 * Pseudo-code for spawning Node.js process with IPC socket:
 *
 * ```cpp
 * // In plugin initialization
 * bool InitOpenVibeJs() {
 *     // Make socket path
 *     const char* socketPath = "/tmp/openvibe-js.sock";
 *
 *     // Spawn Node.js process
 *     // Equivalent: node engine/openvibe-js-runtime/bridge.js /tmp/openvibe-js.sock
 *     PROCESS_INFORMATION pi;
 *     STARTUPINFO si = {0};
 *     si.cb = sizeof(si);
 *
 *     char cmdLine[512];
 *     sprintf(cmdLine, "node engine\\openvibe-js-runtime\\bridge.js %s", socketPath);
 *
 *     if (!CreateProcessA(NULL, cmdLine, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
 *         return false;
 *     }
 *
 *     // Close process handle, keep thread handle
 *     CloseHandle(pi.hProcess);
 *     CloseHandle(pi.hThread);
 *
 *     // Connect to socket
 *     return g_JsClient.Connect();
 * }
 * ```
 */

/**
 * BRIDGE ENTRY POINT
 *
 * To use this bridge from C++, start Node.js like this:
 *
 * ```bash
 * # Linux
 * node engine/openvibe-js-runtime/bridge-socket.js /tmp/openvibe-js.sock
 *
 * # Windows (use named pipes instead)
 * node engine/openvibe-js-runtime/bridge-socket.js \\\\.\\pipe\\OpenVibeJs
 * ```
 *
 * The bridge will:
 * 1. Create a Unix socket server
 * 2. Wait for C++ to connect
 * 3. Initialize OpenVibe.JS runtime
 * 4. Exchange messages (JSON over socket)
 * 5. Call hooks when C++ sends events
 */

if (require.main === module) {
  // Launched directly: node bridge-socket.js <socket_path>
  const socketPath = process.argv[2] || '/tmp/openvibe-js.sock';
  const bridge = new OpenVibeJsBridge(socketPath);

  runtime.initialize();
  bridge.startServer();

  console.log('[Bridge] OpenVibe.JS Bridge started');
  console.log(`[Bridge] Socket: ${socketPath}`);
  console.log('[Bridge] Waiting for C++ client...');
}
