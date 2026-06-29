#!/usr/bin/env bash
# OpenVibe BSP Compilation Script
# Compiles VMF files to BSP format using Wine + TF2 tools
# Requires: Wine, Team Fortress 2 installed via Steam

set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

# Configuration
TF2_INSTALL_DIR="${TF2_INSTALL_DIR:-$HOME/.steam/steam/steamapps/common/Team Fortress 2}"
VBSP_TOOL="$TF2_INSTALL_DIR/bin/vbsp.exe"
VVIS_TOOL="$TF2_INSTALL_DIR/bin/vvis.exe"
VRAD_TOOL="$TF2_INSTALL_DIR/bin/vrad.exe"

# Check prerequisites
check_prerequisites() {
    if ! command -v wine &> /dev/null; then
        echo "❌ Wine is not installed. Install with: sudo apt-get install wine wine32"
        exit 1
    fi

    if ! command -v node &> /dev/null; then
        echo "❌ Node.js is not installed."
        exit 1
    fi

    if [ ! -d "$TF2_INSTALL_DIR" ]; then
        echo "❌ Team Fortress 2 not found at: $TF2_INSTALL_DIR"
        echo "   Set TF2_INSTALL_DIR environment variable to override"
        exit 1
    fi

    if [ ! -f "$VBSP_TOOL" ]; then
        echo "❌ VBSP tool not found at: $VBSP_TOOL"
        exit 1
    fi

    echo "✓ Prerequisites check passed"
}

# Generate VMF files from templates
generate_vmfs() {
    echo "📝 Generating VMF files from templates..."
    node "$ROOT/tools/generate-dev-vmfs.mjs"
    echo "✓ VMF files generated"
}

# Compile all maps
compile_all_maps() {
    local maps=(
        "ov_hub"
        "ph_openvibe_dev"
        "dr_openvibe_dev"
        "fw_openvibe_dev"
        "tt_openvibe_dev"
    )

    echo "🎬 Compiling all maps..."
    for map in "${maps[@]}"; do
        "$ROOT/tools/compile-map-wine.sh" "$map" || echo "⚠️  Failed to compile $map"
    done
    echo "✓ Map compilation complete"
}

# Main execution
main() {
    echo "🚀 OpenVibe BSP Compilation Tool"
    echo "=================================="
    echo ""
    
    check_prerequisites
    echo ""
    
    generate_vmfs
    echo ""
    
    compile_all_maps
    echo ""
    
    echo "✅ All done! BSP files ready in: $ROOT/game/openvibe.games/maps"
    echo ""
    echo "Next steps:"
    echo "  1. Copy BSP files to your SRCDS installation"
    echo "  2. Start the development servers with: $ROOT/tools/dev-up.sh"
}

main
