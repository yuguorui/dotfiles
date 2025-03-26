# Dotfiles

## Install
```shell
# install nodejs
NODE_VER=v22.14.0
if [ -z $(command -v node) ] || ! (node -v |grep ${NODE_VER}); then
    NODE_RELEASE=node-${NODE_VER}-linux-x64-glibc-217
    curl https://unofficial-builds.nodejs.org/download/release/${NODE_VER}/${NODE_RELEASE}.tar.gz -o ${NODE_RELEASE}.tar.gz
    mkdir -p ~/.local/opt && tar -xvf ${NODE_RELEASE}.tar.gz -C ~/.local/opt && rm -rf ${NODE_RELEASE}.tar.gz
    export PATH=$HOME/.local/opt/${NODE_RELEASE}/bin:$PATH
fi

# install nvim it self
if [ -z $(command -v nvim) ]; then
    curl -LO https://github.com/neovim/neovim/releases/download/v0.10.4/nvim-linux-x86_64.appimage
    chmod u+x nvim-linux-x86_64.appimage
    sudo mv nvim-linux-x86_64.appimage /usr/local/bin/nvim
    sudo ln -s /usr/local/bin/nvim /usr/local/bin/vim
fi

# install chezmoi
if [ -z $(command -v chezmoi) ]; then
    mkdir -p $HOME/.local/bin
    release=2.60.1
    curl -LO https://github.com/twpayne/chezmoi/releases/download/v${release}/chezmoi_${release}_linux-musl_amd64.tar.gz
    tar -C $HOME/.local/bin -xf chezmoi_${release}_linux-musl_amd64.tar.gz chezmoi
    rm -f chezmoi_${release}_linux-musl_amd64.tar.gz
fi
export PATH=$HOME/.local/bin:$PATH
chezmoi init https://github.com/yuguorui/dotfiles.git
