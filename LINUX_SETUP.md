# OpenVibe: Source - Linux Setup & Run Guide

Complete step-by-step guide to set up and run OpenVibe: Source on Linux.

## Prerequisites

### System Requirements
- Ubuntu 20.04 LTS or later (tested on 22.04 LTS)
- 50GB free disk space (SRCDS + Steam apps)
- 8GB RAM minimum (16GB recommended for multiple servers)
- 4-core CPU minimum

### Required Software

#### 1. Install system dependencies
```bash
sudo apt-get update
sudo apt-get install -y \
  git curl wget build-essential \
  python3 python3-pip \
  node.js npm \
  wine wine32 wine64 winetricks \
  lib32gcc-s1 lib32stdc++6 \
  libssl-dev libffi-dev \
  postgresql postgresql-contrib \
  docker.io docker-compose \
  tmux screen \
  jq
```

#### 2. Install Proton Experimental (for SRCDS on Linux)
```bash
# Download Proton Experimental if using newer Steam
# For Proton 8.x+, set up environment:
export PROTON_VERSION="experimental"
export STEAM_COMPAT_TOOLS_PATHS="/home/$USER/.steam/root/compatibilitytools.d"

# Or use native SRCDS if available for your engine version
```

#### 3. Install Steam and SteamCMD
```bash
mkdir -p ~/steamcmd
cd ~/steamcmd
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -

# Login to Steam
./steamcmd.sh
  > login anonymous
  > quit

# Add to PATH
echo 'export PATH="$PATH:$HOME/steamcmd"' >> ~/.bashrc
source ~/.bashrc
```

#### 4. Install Team Fortress 2 (for BSP compilation tools)
```bash
steamcmd.sh \
  +login anonymous \
  +app_update 440 validate \
  +quit

# Wait for download (~15GB)
```

#### 5. Install HL2: Deathmatch (game base)
```bash
steamcmd.sh \
  +login anonymous \
  +app_update 320 validate \
  +quit
```

## OpenVibe Setup

### 1. Clone the repository
```bash
cd ~
git clone https://github.com/yourusername/openvibe-source.git
cd openvibe-source
```

### 2. Set up environment variables
```bash
# Create ~/.bashrc additions
cat >> ~/.bashrc << 'EOF'
export OPENVIBE_ROOT="$HOME/openvibe-source"
export TF2_INSTALL_DIR="$HOME/.steam/steam/SteamApps/common/Team Fortress 2"
export HL2_INSTALL_DIR="$HOME/.steam/steam/SteamApps/common/Half-Life 2 Deathmatch"
export SRCDS_DIR="$HOME/srcds"
export OV_API_ENDPOINT="http://localhost:3000"
export OV_API_SECRET="your-secret-key-here"
EOF

source ~/.bashrc
```

### 3. Set up SRCDS installation
```bash
# Create SRCDS directory structure
mkdir -p $SRCDS_DIR/hlserver/orangebox/cfg
mkdir -p $SRCDS_DIR/hlserver/orangebox/maps
mkdir -p $SRCDS_DIR/hlserver/orangebox/logs

# Copy game files from HL2:DM installation
cp -r "$HL2_INSTALL_DIR/hl2mp" "$SRCDS_DIR/hlserver/orangebox/"
cp -r "$HL2_INSTALL_DIR/bin" "$SRCDS_DIR/hlserver/orangebox/"
cp -r "$HL2_INSTALL_DIR/orange.gcf" "$SRCDS_DIR/hlserver/orangebox/" || true
```

### 4. Set up PostgreSQL database
```bash
# Start PostgreSQL
sudo systemctl start postgresql

# Create database
sudo -u postgres psql << 'EOF'
CREATE DATABASE openvibe;
CREATE USER openvibe WITH PASSWORD 'openvibe_dev_password';
ALTER ROLE openvibe SET client_encoding TO 'utf8';
ALTER ROLE openvibe SET default_transaction_isolation TO 'read committed';
ALTER ROLE openvibe SET default_transaction_deferrable TO on;
ALTER ROLE openvibe SET timezone TO 'UTC';
GRANT ALL PRIVILEGES ON DATABASE openvibe TO openvibe;
EOF

# Initialize database schema
cd $OPENVIBE_ROOT/backend
npm install
npm run db:migrate
```

### 5. Install backend dependencies
```bash
cd $OPENVIBE_ROOT/backend
npm install
npm run build
```

### 6. Compile maps (requires Wine + TF2 tools)
```bash
cd $OPENVIBE_ROOT

# Make script executable
chmod +x tools/compile-dev-maps-wine.sh

# Compile all maps (VIS can be slow, skip with VVIS_ENABLED=0)
VVIS_ENABLED=0 ./tools/compile-dev-maps-wine.sh

# Copy compiled BSPs to SRCDS
cp game/openvibe.games/maps/*.bsp $SRCDS_DIR/hlserver/orangebox/hl2mp/maps/
```

### 7. Copy OpenVibe game content
```bash
# Copy scripts
mkdir -p $SRCDS_DIR/hlserver/orangebox/hl2mp/scripts/vscripts
cp game/openvibe.games/scripts/vscripts/*.nut \
   $SRCDS_DIR/hlserver/orangebox/hl2mp/scripts/vscripts/

# Copy configs
mkdir -p $SRCDS_DIR/hlserver/orangebox/hl2mp/cfg
cp game/openvibe.games/cfg/*.cfg \
   $SRCDS_DIR/hlserver/orangebox/hl2mp/cfg/

# Copy resources
mkdir -p $SRCDS_DIR/hlserver/orangebox/hl2mp/resource
cp game/openvibe.games/resource/*.txt \
   $SRCDS_DIR/hlserver/orangebox/hl2mp/resource/

# Copy particles
mkdir -p $SRCDS_DIR/hlserver/orangebox/hl2mp/particles
cp game/openvibe.games/particles/* \
   $SRCDS_DIR/hlserver/orangebox/hl2mp/particles/
```

## Configuration

### 1. Configure server.cfg
```bash
cat > $SRCDS_DIR/hlserver/orangebox/hl2mp/cfg/server.cfg << 'EOF'
// OpenVibe Server Configuration

// Server settings
hostname "OpenVibe - Hub [US-East]"
rcon_password "your-secure-rcon-password"

// OpenVibe settings
ov_api_endpoint "http://localhost:3000"
ov_server_id "us-east-hub-01"
ov_server_secret "your-server-secret"

// Network
rate 30000
cl_cmdrate 66
sv_mincmdrate 10

// Gameplay
mp_friendlyfire 0
mp_falldamage 0
mp_teamplay 1

// Logging
log on
sv_log_onefile 1
EOF
```

### 2. Configure backend API (.env)
```bash
cat > $OPENVIBE_ROOT/backend/.env << 'EOF'
# Database
DATABASE_URL="postgresql://openvibe:openvibe_dev_password@localhost:5432/openvibe"

# Server
NODE_ENV="production"
PORT=3000
LOG_LEVEL="info"

# Admin
ADMIN_SECRET_KEY="your-admin-secret-key"

# Steam
STEAM_APP_ID="YOUR_STEAM_APP_ID"
STEAM_API_KEY="your-steam-api-key"
EOF
```

## Running the Servers

### 1. Start the API backend
```bash
cd $OPENVIBE_ROOT/backend
npm start

# Or with Docker
cd $OPENVIBE_ROOT
docker-compose -f infra/docker-compose.yml up -d
```

### 2. Start all game servers (via tmux)
```bash
# Make dev-up script executable
chmod +x $OPENVIBE_ROOT/tools/dev-up.sh

# Start all 5 servers + sidecar
$OPENVIBE_ROOT/tools/dev-up.sh

# Attach to tmux session to view output
tmux attach-session -t openvibe
```

### 3. Manual server startup (single server)
```bash
# For Hub server
cd $SRCDS_DIR/hlserver
./srcds_run -game hl2mp \
  +map ov_hub \
  -maxplayers 32 \
  -port 27015 \
  +sv_pure 0 \
  +exec server.cfg \
  -console

# For Prop Hunt server
cd $SRCDS_DIR/hlserver
./srcds_run -game hl2mp \
  +map ph_openvibe_dev \
  -maxplayers 16 \
  -port 27016 \
  +sv_pure 0 \
  +exec server.cfg \
  -console
```

### 4. Connect client
```bash
# With Proton Experimental
PROTON_EXPERIMENTAL=1 steam steam://run/320//-console +connect 127.0.0.1:27015

# Or via console
> connect 127.0.0.1:27015
> ov_join hub
```

## Troubleshooting

### Game server won't start
```bash
# Check SRCDS binary exists
ls -la $SRCDS_DIR/hlserver/srcds_run

# Run with verbose output
./srcds_run -game hl2mp +map ov_hub -console -debug

# Check for missing libraries
ldd ./srcds_i486
```

### API connection fails
```bash
# Check backend is running
curl http://localhost:3000/health

# Check logs
docker logs openvibe_api

# Verify PostgreSQL
sudo -u postgres psql openvibe -c "SELECT 1;"
```

### BSP compilation errors
```bash
# Check TF2 installation
ls -la "$TF2_INSTALL_DIR/bin/"

# Run VBSP manually for debugging
WINEARCH=win32 wine "$TF2_INSTALL_DIR/bin/vbsp.exe" \
  -game "$TF2_INSTALL_DIR/tf" \
  "$OPENVIBE_ROOT/game/openvibe.games/maps/ov_hub.vmf"
```

### VScript errors in server console
```bash
# Check script files exist
ls -la $SRCDS_DIR/hlserver/orangebox/hl2mp/scripts/vscripts/

# Enable VScript logging
sv_script_debug 1

# Check logs directory has write permissions
chmod 777 $SRCDS_DIR/hlserver/orangebox/hl2mp/logs
```

### Player can't join servers
```bash
# Check firewall rules
sudo ufw status
sudo ufw allow 27015:27020/udp
sudo ufw allow 27015:27020/tcp

# Check SRCDS is listening
netstat -tulnp | grep -E "27015|27016|27017|27018|27019"

# Verify server loads map correctly
# Look for: "Didn't load map" errors in console
```

## Development Workflow

### 1. Modify VScript logic
```bash
# Edit game mode script
nano $OPENVIBE_ROOT/game/openvibe.games/scripts/vscripts/ov_prophunt.nut

# Changes take effect on map reload (no restart needed)
# In-game console: `changelevel ph_openvibe_dev`
```

### 2. Modify backend API
```bash
# Edit endpoint
nano $OPENVIBE_ROOT/backend/src/app.ts

# Rebuild TypeScript
cd $OPENVIBE_ROOT/backend
npm run build

# Restart API
docker-compose -f infra/docker-compose.yml restart api
```

### 3. Update maps
```bash
# Edit VMF in Hammer Editor (if available)
# Or modify generator
nano $OPENVIBE_ROOT/tools/generate-dev-vmfs.mjs

# Regenerate and compile
cd $OPENVIBE_ROOT
./tools/compile-dev-maps-wine.sh

# Copy new BSP
cp game/openvibe.games/maps/ph_openvibe_dev.bsp $SRCDS_DIR/hlserver/orangebox/hl2mp/maps/

# Reload map in-game
```

## Monitoring

### Check server status
```bash
# List running SRCDS processes
ps aux | grep srcds

# Check port availability
netstat -tulnp | grep -E "27015|27016|27017"

# Check API health
curl http://localhost:3000/health | jq .
```

### View logs
```bash
# SRCDS logs
tail -f $SRCDS_DIR/hlserver/orangebox/hl2mp/logs/L*.log

# API logs
docker logs -f openvibe_api

# Sidecar logs
tmux capture-pane -t openvibe:sidecar -p

# PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql.log
```

## Performance Tuning

### Increase SRCDS performance
```bash
# Adjust rate limits for better responsiveness
rate 30000
cl_cmdrate 66
sv_mincmdrate 10

# Adjust tickrate (higher = more CPU usage)
sv_tickrate 66
```

### Database optimization
```bash
# Enable query logging
sudo -u postgres psql openvibe -c "ALTER SYSTEM SET log_min_duration_statement = 100;"
sudo systemctl restart postgresql

# Check indexes
sudo -u postgres psql openvibe -c "\d+ players"
sudo -u postgres psql openvibe -c "\d+ matches"
```

## Deployment to Production

### 1. Use environment-specific configs
```bash
# Production backend config
cp $OPENVIBE_ROOT/backend/.env.example $OPENVIBE_ROOT/backend/.env.production
# Edit with real credentials and settings
nano $OPENVIBE_ROOT/backend/.env.production
```

### 2. Use Docker for all services
```bash
# Production docker-compose
docker-compose -f infra/docker-compose.yml up -d

# Enable restart policy
docker update --restart=unless-stopped openvibe_api
docker update --restart=unless-stopped openvibe_db
```

### 3. Set up SSL/TLS reverse proxy
```bash
# Use nginx or similar
# Configure with valid certificates
# Point to http://localhost:3000 backend
```

### 4. Enable server monitoring
```bash
# Use systemd service files for SRCDS instances
# Set up Prometheus/Grafana for metrics
# Configure alerts for server crashes
```

## Useful Commands

```bash
# List all tmux sessions
tmux list-sessions

# Attach to specific server
tmux attach-session -t openvibe:hub

# Kill all servers
tmux kill-session -t openvibe

# Check SRCDS console remotely
tmux capture-pane -t openvibe:hub -p

# Execute command on server
tmux send-keys -t openvibe:hub "say Hello from console" Enter

# View leaderboard
curl "http://localhost:3000/v1/leaderboard?limit=10" | jq .

# Create admin shop item
curl -X POST http://localhost:3000/v1/admin/shop/items \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: your-admin-secret" \
  -d '{"name":"Cool Skin","type":"model","price":5000}'
```

## Support & Debugging

### Enable verbose logging
```bash
# In server.cfg
developer 2
sv_log_onefile 1
sv_script_debug 1

# In OpenVibe config
OV_DEBUG=1
```

### Generate debug package
```bash
cd $OPENVIBE_ROOT
mkdir -p debug-export
cp game/openvibe.games/scripts/vscripts/*.nut debug-export/
cp tools/ov-sidecar.mjs debug-export/
docker logs openvibe_api > debug-export/api.log
docker logs openvibe_db > debug-export/db.log
# Tar for sharing
tar czf openvibe-debug-$(date +%Y%m%d-%H%M%S).tar.gz debug-export/
```

## Next Steps

1. **Customize game modes** - Edit VScript files to adjust gameplay
2. **Add more cosmetics** - Use `/v1/admin/shop/items` to add items
3. **Set up web dashboard** - Create a web UI that connects to the API
4. **Configure Steam integration** - Add proper Steam authentication
5. **Deploy to production** - Use Docker Swarm or Kubernetes

---

For more information, see:
- [Architecture Documentation](./docs/architecture.md)
- [Backend API Docs](./backend/README.md)
- [VScript Reference](./game/openvibe.games/scripts/vscripts/ov_shared.nut)
