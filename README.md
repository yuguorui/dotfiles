# Dotfiles

## Install

Codex++ 官方 release 支持 Apple Silicon macOS 和 Linux x64；Linux 使用 Homebrew 官方支持的 glibc 发行版。

```shell
set -eu

case "$(uname -s)/$(uname -m)" in
    Darwin/arm64|Linux/x86_64|Linux/amd64) ;;
    *) echo "Codex++ release supports Apple Silicon macOS and Linux x64" >&2; exit 1 ;;
esac

# Linux needs these packages before bootstrapping Homebrew.
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y build-essential procps curl file git
elif command -v dnf >/dev/null 2>&1; then
    sudo dnf group install -y development-tools
    sudo dnf install -y procps-ng curl file git
elif command -v yum >/dev/null 2>&1; then
    sudo yum groupinstall -y 'Development Tools'
    sudo yum install -y procps-ng curl file git
elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm base-devel procps-ng curl file git
fi

# Install Homebrew and expose brew-installed tools in this shell.
BREW_BIN=$(command -v brew 2>/dev/null || true)
if [ -z "$BREW_BIN" ]; then
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
        if [ -x "$candidate" ]; then
            BREW_BIN=$candidate
            break
        fi
    done
fi

if [ -z "$BREW_BIN" ]; then
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
        if [ -x "$candidate" ]; then
            BREW_BIN=$candidate
            break
        fi
    done
fi

if [ -z "$BREW_BIN" ]; then
    echo "Homebrew installation failed" >&2
    exit 1
fi
eval "$("$BREW_BIN" shellenv)"

brew install curl git node neovim chezmoi

# Install the maintained Codex++ fork. The release installer verifies SHA-256
# checksums and installs the command into ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v codex++ >/dev/null 2>&1; then
    codex_installer=$(mktemp)
    trap 'rm -f "$codex_installer"' EXIT
    curl -fsSL https://github.com/yuguorui/codex-plus/releases/latest/download/install-fork.sh -o "$codex_installer"
    CODEX_NON_INTERACTIVE=true sh "$codex_installer"
    rm -f "$codex_installer"
    trap - EXIT
fi

chezmoi init --apply https://github.com/yuguorui/dotfiles.git
command -v codex++ >/dev/null 2>&1 || { echo "codex++ is not available in PATH" >&2; exit 1; }
codex++ --version
```

