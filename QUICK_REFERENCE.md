# OpenVibe: Source - Quick Reference

## File Locations

### C++ GameDLL Components
```
engine/source-sdk-2013/src/game/
├── server/hl2mp/
│   ├── openvibe_travel.cpp          # ov_join, prop disguise
│   └── openvibe_steam_auth.cpp      # Steam auth integration
└── client/hl2mp/
    └── vgui_openvibe_menu.cpp       # Custom main menu UI
```

### Game Content
```
game/openvibe.games/
├── scripts/vscripts/
│   ├── ov_shared.nut                # Shared utilities
│   ├── ov_hub.nut                   # Hub mode
│   ├── ov_prophunt.nut              # Prop Hunt
│   ├── ov_deathrun.nut              # Deathrun
│   ├── ov_fortwars.nut              # Fort Wars
│   └── ov_traitortown.nut           # Traitor Town
├── cfg/
│   ├── ov_hub.cfg                   # Auto-exec
│   ├── ph_openvibe_dev.cfg
│   ├── dr_openvibe_dev.cfg
│   ├── fw_openvibe_dev.cfg
│   └── tt_openvibe_dev.cfg
├── maps/
│   ├── ov_hub.vmf / .bsp
│   ├── ph_openvibe_dev.vmf / .bsp
│   ├── dr_openvibe_dev.vmf / .bsp
│   ├── fw_openvibe_dev.vmf / .bsp
│   └── tt_openvibe_dev.vmf / .bsp
├── resource/
│   └── openvibe_english.txt
└── particles/
    ├── particle_manifest.txt
    └── openvibe_trails.pcf
```

### Backend
```
backend/
├── src/
│   ├── app.ts                       # Fastify app + endpoints
│   ├── domain.ts                    # Type definitions
│   ├── schemas.ts                   # Validation schemas
│   ├── repository-pg.ts             # PostgreSQL queries
│   └── app.test.ts                  # Tests
└── Dockerfile
```

### Infrastructure
```
infra/
└── docker-compose.yml               # PostgreSQL + API
tools/
├── generate-dev-vmfs.mjs            # VMF generation
├── compile-dev-maps-wine.sh         # BSP compilation
├── ov-sidecar.mjs                   # Log bridge to API
├── run-sidecar.sh                   # Sidecar launcher
└── dev-up.sh                        # Start all servers
```

### Documentation
```
LINUX_SETUP.md                       # Linux deployment guide
docs/
├── PHASE_2_SUMMARY.md               # Implementation summary
├── architecture.md                  # System design
└── README.md                        # Main overview
```

---

## Quick Start (Linux)

### 1. Initial Setup (15-20 minutes)
```bash
# Set up Steam/SteamCMD
mkdir -p ~/steamcmd && cd ~/steamcmd
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -

# Install game files
./steamcmd.sh +login anonymous +app_update 320 validate +quit  # HL2:DM
./steamcmd.sh +login anonymous +app_update 440 validate +quit  # TF2

# Install dependencies
sudo apt-get install -y wine wine32 postgresql postgresql-contrib docker.io node.js npm

# Clone project
cd ~
git clone https://github.com/yourusername/openvibe-source.git
cd openvibe-source
```

### 2. Database Setup (5 minutes)
```bash
# Start PostgreSQL
sudo systemctl start postgresql

# Initialize database
cd backend && npm install && npm run db:migrate

# Verify
npm test
```

### 3. Map Compilation (30-60 minutes, one-time)
```bash
# Compile BSPs
VVIS_ENABLED=0 ./tools/compile-dev-maps-wine.sh

# Verify output
ls -lh game/openvibe.games/maps/*.bsp
```

### 4. Start Servers (2 minutes)
```bash
# Terminal 1: Start API
cd backend && npm start

# Terminal 2: Start game servers
./tools/dev-up.sh

# Attach to monitor
tmux attach-session -t openvibe
```

### 5. Connect Client (1 minute)
```bash
# In Half-Life 2 Deathmatch console:
> connect 127.0.0.1:27015
> ov_join hub
```

---

## ConCommands

### Client (in-game console)
```bash
# Travel to game mode
ov_join hub              # Hub server
ov_join prophunt         # Prop Hunt
ov_join deathrun         # Deathrun
ov_join fortwars         # Fort Wars
ov_join traitortown      # Traitor Town

# Authentication
ov_auth_ticket <hex>     # Send auth ticket to server
ov_auth_confirm <token>  # Confirm authentication

# Server Connection
connect 127.0.0.1:27015  # Connect to Hub (port 27015)
disconnect               # Leave server
```

### Server (SRCDS console)
```bash
# Prop Hunt
ov_prophunt_disguise models/props_c17/can_stack_01a.mdl

# Debugging
developer 2
sv_script_debug 1

# Map changes
changelevel ph_openvibe_dev
```

---

## API Endpoints

### Public
```bash
# Get leaderboard (top 10 players)
curl http://localhost:3000/v1/leaderboard?limit=10

# Get player profile
curl http://localhost:3000/v1/players/76561198123456789

# Get active servers
curl http://localhost:3000/v1/servers

# Initiate travel
curl -X POST http://localhost:3000/v1/travel/request \
  -H "Content-Type: application/json" \
  -d '{"steamId":"76561198...", "targetMode":"prophunt"}'
```

### Admin (requires X-Admin-Secret header)
```bash
# Create shop item
curl -X POST http://localhost:3000/v1/admin/shop/items \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"name":"Cool Skin","type":"model","price":5000}'

# Give player currency
curl -X POST http://localhost:3000/v1/admin/players/76561198.../balance \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"amount":10000}'
```

---

## Game Mode Servers

| Mode | Port | Max Players | Map |
|------|------|-------------|-----|
| Hub | 27015 | 32 | ov_hub |
| Prop Hunt | 27016 | 16 | ph_openvibe_dev |
| Deathrun | 27017 | 16 | dr_openvibe_dev |
| Fort Wars | 27018 | 16 | fw_openvibe_dev |
| Traitor Town | 27019 | 16 | tt_openvibe_dev |

---

## Troubleshooting

### "Map failed to load"
```bash
# Check BSP exists
ls -la game/openvibe.games/maps/*.bsp

# Verify it copied to SRCDS
ls -la $SRCDS_DIR/hlserver/orangebox/hl2mp/maps/
```

### "API not responding"
```bash
# Check backend is running
curl http://localhost:3000/health

# Check database connection
cd backend && npm run db:check
```

### "VScript errors"
```bash
# Enable debug mode
sv_script_debug 1

# Check script files
ls -la game/openvibe.games/scripts/vscripts/

# Check logs
tail -f $SRCDS_DIR/hlserver/orangebox/hl2mp/logs/L*.log
```

### "Can't connect to server"
```bash
# Check firewall
sudo ufw allow 27015:27020/udp
sudo ufw allow 27015:27020/tcp

# Verify SRCDS listening
netstat -tulnp | grep -E "27015|27016"

# Check firewall status
sudo ufw status
```

---

## Environment Variables

```bash
# Set in ~/.bashrc
export OPENVIBE_ROOT="$HOME/openvibe-source"
export TF2_INSTALL_DIR="$HOME/.steam/steam/SteamApps/common/Team Fortress 2"
export HL2_INSTALL_DIR="$HOME/.steam/steam/SteamApps/common/Half-Life 2 Deathmatch"
export SRCDS_DIR="$HOME/srcds"
export OV_API_ENDPOINT="http://localhost:3000"
export OV_API_SECRET="your-secret-key"
export DATABASE_URL="postgresql://openvibe:password@localhost:5432/openvibe"
```

---

## Performance Tuning

### SRCDS
```bash
# Rate limits (in server.cfg)
rate 30000
cl_cmdrate 66
sv_mincmdrate 10

# Tickrate (higher = more CPU, more responsive)
sv_tickrate 66
```

### Database
```bash
# Connect to PostgreSQL and check
sudo -u postgres psql openvibe
> SELECT COUNT(*) FROM players;
> SELECT * FROM matches ORDER BY created_at DESC LIMIT 1;
> ANALYZE;  # Update statistics
```

---

## Monitoring

### Check All Services
```bash
# SRCDS processes
ps aux | grep srcds | grep -v grep

# API status
curl http://localhost:3000/health

# Database status
sudo systemctl status postgresql

# Docker status
docker ps | grep openvibe
```

### View Logs
```bash
# SRCDS
tail -f $SRCDS_DIR/hlserver/orangebox/hl2mp/logs/L*.log

# API
docker logs -f openvibe_api

# Sidecar (in tmux)
tmux capture-pane -t openvibe:sidecar -p

# PostgreSQL
sudo tail -f /var/log/postgresql/postgresql.log
```

---

## Useful Scripts

### Restart All Services
```bash
#!/bin/bash
# Kill old processes
killall srcds_i486 2>/dev/null || true
tmux kill-session -t openvibe 2>/dev/null || true

# Restart backend
docker-compose -f infra/docker-compose.yml restart

# Start servers
./tools/dev-up.sh

echo "All services restarted"
```

### Backup Database
```bash
#!/bin/bash
sudo -u postgres pg_dump openvibe > openvibe_backup_$(date +%Y%m%d_%H%M%S).sql
```

### Check Server Health
```bash
#!/bin/bash
for port in 27015 27016 27017 27018 27019; do
  if netstat -tulnp 2>/dev/null | grep -q ":$port"; then
    echo "✓ Port $port (running)"
  else
    echo "✗ Port $port (down)"
  fi
done
```

---

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "SRCDS not found" | `export SRCDS_DIR=~/srcds` and run setup |
| "TF2 tools not found" | Install TF2 via SteamCMD, set `TF2_INSTALL_DIR` |
| "Wine not found" | `sudo apt-get install wine wine32` |
| "Database connection failed" | Start PostgreSQL: `sudo systemctl start postgresql` |
| "Port already in use" | Kill existing SRCDS: `pkill -f srcds` |
| "VScript not loading" | Verify cfg files in `game/openvibe.games/cfg/` |
| "API timeout" | Check backend logs: `docker logs openvibe_api` |

---

## Next Steps

1. **Customize** - Edit VScript files for your own game rules
2. **Extend** - Add more game modes or cosmetics
3. **Deploy** - Follow production guide for public servers
4. **Monetize** - Integrate payment processor for shop
5. **Market** - Launch on Steam with your game

---

**For detailed setup instructions, see:** [`LINUX_SETUP.md`](./LINUX_SETUP.md)

**For architecture details, see:** [`docs/architecture.md`](./docs/architecture.md)

**For implementation details, see:** [`docs/PHASE_2_SUMMARY.md`](./docs/PHASE_2_SUMMARY.md)
