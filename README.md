# Dotfiles

## Install
```shell
# detect arch
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)     NVIM_ARCH=x86_64; CHEZMOI_ARCH=linux-musl_amd64 ;;
    aarch64)    NVIM_ARCH=arm64; CHEZMOI_ARCH=linux_arm64 ;;
    arm64)      NVIM_ARCH=arm64; CHEZMOI_ARCH=linux_arm64 ;;
    *)          echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# install nodejs
NODE_VER=v22.14.0
if [ -z $(command -v node) ] || ! (node -v |grep ${NODE_VER}); then
    case "$ARCH" in
        x86_64)
            NODE_RELEASE=node-${NODE_VER}-linux-x64-glibc-217
            curl -L https://unofficial-builds.nodejs.org/download/release/${NODE_VER}/${NODE_RELEASE}.tar.gz -o ${NODE_RELEASE}.tar.gz
            mkdir -p ~/.local/opt && tar -xzf ${NODE_RELEASE}.tar.gz -C ~/.local/opt && rm -f ${NODE_RELEASE}.tar.gz
            ;;
        aarch64|arm64)
            NODE_RELEASE=node-${NODE_VER}-linux-arm64
            curl -fsSL https://nodejs.org/dist/${NODE_VER}/${NODE_RELEASE}.tar.xz -o ${NODE_RELEASE}.tar.xz
            mkdir -p ~/.local/opt && tar -xJf ${NODE_RELEASE}.tar.xz -C ~/.local/opt && rm -f ${NODE_RELEASE}.tar.xz
            ;;
    esac
    export PATH=$HOME/.local/opt/${NODE_RELEASE}/bin:$PATH
fi

# install nvim it self
if [ -z $(command -v nvim) ]; then
    curl -LO https://github.com/neovim/neovim/releases/download/v0.12.2/nvim-linux-${NVIM_ARCH}.tar.gz
    mkdir -p ~/.local/opt && tar -xzf nvim-linux-${NVIM_ARCH}.tar.gz -C ~/.local/opt && rm -f nvim-linux-${NVIM_ARCH}.tar.gz
    sudo ln -sf $HOME/.local/opt/nvim-linux-${NVIM_ARCH}/bin/nvim /usr/local/bin/nvim
    sudo ln -sf /usr/local/bin/nvim /usr/local/bin/vim
fi

# install bun
curl -fsSL https://bun.com/install | bash

# install opencode from fork
if [ -z $(command -v opencode) ]; then
    export PATH=$HOME/.bun/bin:$PATH
    git clone https://github.com/yuguorui/opencode.git
    cd opencode
    bun install
    ./packages/opencode/script/build.ts --single
    # map x86_64 to x64 to be compatible with the original releases
    arch=$(uname -m)
    if [ "$arch" = "x86_64" ]; then
        arch="x64"
    fi
    cp -a packages/opencode/dist/opencode-$(uname -s|tr '[:upper:]' '[:lower:]')-${arch}/bin/opencode $HOME/.local/bin
fi

# install chezmoi
if [ -z $(command -v chezmoi) ]; then
    mkdir -p $HOME/.local/bin
    release=2.60.1
    curl -LO https://github.com/twpayne/chezmoi/releases/download/v${release}/chezmoi_${release}_${CHEZMOI_ARCH}.tar.gz
    tar -C $HOME/.local/bin -xf chezmoi_${release}_${CHEZMOI_ARCH}.tar.gz chezmoi
    rm -f chezmoi_${release}_${CHEZMOI_ARCH}.tar.gz
fi
export PATH=$HOME/.local/bin:$PATH
chezmoi init https://github.com/yuguorui/dotfiles.git

