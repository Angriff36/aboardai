# Installing AboardAI on Fedora/RHEL

This guide covers installation of AboardAI on Fedora, RHEL, Rocky Linux, AlmaLinux, and other RPM-based distributions.

## Prerequisites

AboardAI requires:

- **64-bit x86_64 architecture**
- **Fedora 39+** or **RHEL 9+** (earlier versions may work but not officially supported)
- **4GB RAM minimum**, 8GB recommended
- **~300MB disk space** for installation
- **Internet connection** for installation and Claude API access

### Authentication

You'll need one of the following:

- **Claude CLI** (recommended) - `claude login`
- **API key** - Set `ANTHROPIC_API_KEY` environment variable

See main [README.md authentication section](../README.md#authentication) for details.

## Installation

### Option 1: Download and Install from GitHub

1. Visit [GitHub Releases](https://github.com/AboardAI-Org/aboardai/releases)
2. Find the latest release and download the `.rpm` file:
   - Download: `AboardAI-<version>-x86_64.rpm`

3. Install using dnf (Fedora):

   ```bash
   sudo dnf install ./AboardAI-<version>-x86_64.rpm
   ```

   Or using yum (RHEL/CentOS):

   ```bash
   sudo yum localinstall ./AboardAI-<version>-x86_64.rpm
   ```

### Option 2: Install Directly from URL

Install from GitHub releases URL without downloading first. Visit [releases page](https://github.com/AboardAI-Org/aboardai/releases) to find the latest version.

**Fedora:**

```bash
# Replace v0.11.0 with the actual latest version
sudo dnf install https://github.com/AboardAI-Org/aboardai/releases/download/v0.11.0/AboardAI-0.11.0-x86_64.rpm
```

**RHEL/CentOS:**

```bash
# Replace v0.11.0 with the actual latest version
sudo yum install https://github.com/AboardAI-Org/aboardai/releases/download/v0.11.0/AboardAI-0.11.0-x86_64.rpm
```

## Running AboardAI

After successful installation, launch AboardAI:

### From Application Menu

- Open Activities/Applications
- Search for "AboardAI"
- Click to launch

### From Terminal

```bash
aboardai
```

## System Requirements & Capabilities

### Hardware Requirements

| Component    | Minimum           | Recommended |
| ------------ | ----------------- | ----------- |
| CPU          | Modern multi-core | 4+ cores    |
| RAM          | 4GB               | 8GB+        |
| Disk         | 300MB             | 1GB+        |
| Architecture | x86_64            | x86_64      |

### Required Dependencies

The RPM package automatically installs these dependencies:

```
gtk3              - GTK+ GUI library
libnotify         - Desktop notification library
nss               - Network Security Services
libXScrnSaver     - X11 screensaver library
libXtst           - X11 testing library
xdg-utils         - XDG standards utilities
at-spi2-core      - Accessibility library
libuuid           - UUID library
```

Most of these are pre-installed on typical Fedora/RHEL systems.

### Optional Dependencies

For development (source builds only):

- Node.js 22+
- npm 10+

The packaged application includes its own Electron runtime and does not require system Node.js.

## Supported Distributions

**Officially Tested:**

- Fedora 39, 40 (latest)
- Rocky Linux 9
- AlmaLinux 9

**Should Work:**

- CentOS Stream 9+
- openSUSE Leap/Tumbleweed (with compatibility layer)
- RHEL 9+

**Not Supported:**

- RHEL 8 (glibc 2.28 too old, requires Node.js 22)
- CentOS 7 and earlier
- Fedora versions older than 39

## Configuration

### Environment Variables

Set authentication via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
aboardai
```

Or create `~/.config/aboardai/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Configuration Directory

AboardAI stores configuration and cache in:

```
~/.aboardai/                # Project-specific data
~/.config/aboardai/         # Application configuration
~/.cache/aboardai/          # Cache and temporary files
```

## Troubleshooting

### Application Won't Start

**Check installation:**

```bash
rpm -qi aboardai
rpm -V aboardai
```

**Verify desktop file:**

```bash
cat /usr/share/applications/aboardai.desktop
```

**Run from terminal for error output:**

```bash
aboardai
```

### Missing Dependencies

If dependencies fail to install automatically:

**Fedora:**

```bash
sudo dnf install gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
```

**RHEL/CentOS (enable EPEL first if needed):**

```bash
sudo dnf install epel-release
sudo dnf install gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
```

### SELinux Denials

If AboardAI fails on SELinux-enforced systems:

**Temporary workaround (testing):**

```bash
# Set SELinux to permissive mode
sudo setenforce 0

# Run AboardAI
aboardai

# Check for denials
sudo ausearch -m avc -ts recent | grep aboardai

# Re-enable SELinux
sudo setenforce 1
```

**Permanent fix (not recommended for production):**
Create custom SELinux policy based on ausearch output. For support, see [GitHub Issues](https://github.com/AboardAI-Org/aboardai/issues).

### Port Conflicts

AboardAI uses port 3008 for the internal server. If port is already in use:

**Find process using port 3008:**

```bash
sudo ss -tlnp | grep 3008
# or
lsof -i :3008
```

**Kill conflicting process (if safe):**

```bash
sudo kill -9 <PID>
```

Or configure AboardAI to use different port (see Configuration section).

### Firewall Issues

On Fedora with firewalld enabled:

```bash
# Allow internal traffic (local development only)
sudo firewall-cmd --add-port=3008/tcp
sudo firewall-cmd --permanent --add-port=3008/tcp
```

### GPU/Acceleration

AboardAI uses Chromium for rendering. GPU acceleration should work automatically on supported systems.

**Check acceleration:**

- Look for "GPU acceleration" status in application settings
- Verify drivers: `lspci | grep VGA`

**Disable acceleration if issues occur:**

```bash
DISABLE_GPU_ACCELERATION=1 aboardai
```

### Terminal/Worktree Issues

If terminal emulator fails or git worktree operations hang:

1. Check disk space: `df -h`
2. Verify git installation: `git --version`
3. Check /tmp permissions: `ls -la /tmp`
4. File a GitHub issue with error output

### Unresponsive GUI

If the application freezes:

1. Wait 30 seconds (AI operations may be processing)
2. Check process: `ps aux | grep aboardai`
3. Force quit if necessary: `killall aboardai`
4. Check system resources: `free -h`, `top`

### Network Issues

If Claude API calls fail:

```bash
# Test internet connectivity
ping -c 3 api.anthropic.com

# Test API access
curl -I https://api.anthropic.com

# Verify API key is set (without exposing the value)
[ -n "$ANTHROPIC_API_KEY" ] && echo "API key is set" || echo "API key is NOT set"
```

## Uninstallation

### Remove Application

**Fedora:**

```bash
sudo dnf remove aboardai
```

**RHEL/CentOS:**

```bash
sudo yum remove aboardai
```

### Clean Configuration (Optional)

Remove all user data and configuration:

```bash
# Remove project-specific data
rm -rf ~/.aboardai

# Remove application configuration
rm -rf ~/.config/aboardai

# Remove cache
rm -rf ~/.cache/aboardai
```

**Warning:** This removes all saved projects and settings. Ensure you have backups if needed.

## Building from Source

To build AboardAI from source on Fedora/RHEL:

**Prerequisites:**

```bash
# Fedora
sudo dnf install nodejs npm git

# RHEL (enable EPEL first)
sudo dnf install epel-release
sudo dnf install nodejs npm git
```

**Build steps:**

```bash
# Clone repository
git clone https://github.com/AboardAI-Org/aboardai.git
cd aboardai

# Install dependencies
npm install

# Build packages
npm run build:packages

# Build Linux packages
npm run build:electron:linux

# Packages in: apps/ui/release/
ls apps/ui/release/*.rpm
```

See main [README.md](../README.md) for detailed build instructions.

## Updating AboardAI

**Automatic Updates:**
AboardAI checks for updates on startup. Install available updates through notifications.

**Manual Update:**

```bash
# Fedora
sudo dnf update aboardai

# RHEL/CentOS
sudo yum update aboardai

# Or reinstall latest release
sudo dnf remove aboardai

# Download the latest .rpm from releases page
# https://github.com/AboardAI-Org/aboardai/releases
# Then reinstall with:
# sudo dnf install ./AboardAI-<VERSION>-x86_64.rpm
```

## Getting Help

### Resources

- [Main README](../README.md) - Project overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contributing guide
- [GitHub Issues](https://github.com/AboardAI-Org/aboardai/issues) - Bug reports & feature requests
- [Discussions](https://github.com/AboardAI-Org/aboardai/discussions) - Questions & community

### Reporting Issues

When reporting Fedora/RHEL issues, include:

```bash
# System information
lsb_release -a
uname -m

# AboardAI version
rpm -qi aboardai

# Error output (run from terminal)
aboardai 2>&1 | tee aboardai.log

# SELinux status
getenforce

# Relevant system logs
sudo journalctl -xeu aboardai.service (if systemd service exists)
```

## Performance Tips

1. **Use SSD**: Faster than spinning disk, significantly improves performance
2. **Close unnecessary applications**: Free up RAM for AI agent processing
3. **Disable GPU acceleration if glitchy**: Set `DISABLE_GPU_ACCELERATION=1`
4. **Keep system updated**: `sudo dnf update`
5. **Use latest Fedora/RHEL**: Newer versions have better Electron support

## Security Considerations

### API Key Security

Never commit API keys to version control:

```bash
# Good: Use environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Good: Use .env file (not in git)
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.config/aboardai/.env

# Bad: Hardcoded in files
ANTHROPIC_API_KEY="sk-ant-..." (in any tracked file)
```

### SELinux Security

Running with SELinux disabled (`setenforce 0`) reduces security. Create custom policy:

1. Generate policy from audit logs: `ausearch -m avc -ts recent | grep aboardai`
2. Use selinux-policy tools to create module
3. Install and test module
4. Keep SELinux enforcing

### File Permissions

Ensure configuration files are readable by user only:

```bash
chmod 600 ~/.config/aboardai/.env
chmod 700 ~/.aboardai/
chmod 700 ~/.config/aboardai/
```

## Known Limitations

1. **Single display support**: Multi-monitor setups may have cursor synchronization issues
2. **X11 only**: Wayland support limited (runs under XWayland)
3. **No native systemd service**: Manual launcher or desktop file shortcut
4. **ARM/ARM64**: Not supported, x86_64 only

## Contributing

Found an issue or want to improve Fedora support? See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

**Last Updated**: 2026-01-16
**Tested On**: Fedora 40, Rocky Linux 9, AlmaLinux 9
