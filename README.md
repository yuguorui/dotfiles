# Dotfiles

## Install
```shell
# install nodejs
if [ -z $(command -v node) ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm

    nvm install --lts
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
