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
    curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim.appimage
    chmod u+x nvim.appimage
    sudo mv nvim.appimage /usr/local/bin/nvim
    sudo ln -s /usr/local/bin/nvim /usr/local/bin/vim
fi

# install chezmoi
if [ -z $(command -v chezmoi) ]; then
    sh -c "$(curl -fsLS get.chezmoi.io/lb)"
fi
export PATH=$HOME/.local/bin:$PATH
chezmoi init git@github.com:$USER/dotfiles.git
