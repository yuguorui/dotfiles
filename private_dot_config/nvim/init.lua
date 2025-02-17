vim.g.mapleader = " " -- Make sure to set `mapleader` before lazy so your mappings are correct

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
    vim.fn.system({
        "git",
        "clone",
        "--filter=blob:none",
        "https://github.com/folke/lazy.nvim.git",
        "--branch=stable", -- latest stable release
        lazypath,
    })
end
vim.opt.rtp:prepend(lazypath)

local function getVisualSelection()
    if vim.fn.mode() == "n" then
        -- get word on current cursor
        return vim.fn.expand("<cword>")
    end
    local _, start_row, start_col, _ = unpack(vim.fn.getpos("'<"))
    local _, end_row, end_col, _ = unpack(vim.fn.getpos("'>"))
    local lines = vim.fn.getline(start_row, end_row)
    lines[1] = lines[1]:sub(start_col)
    lines[#lines] = lines[#lines]:sub(1, end_col)
    return table.concat(lines, "\n")
end

function telescope_grep_string()
    local visual_selection = getVisualSelection()
    if #visual_selection > 0 then
        require("telescope.builtin").grep_string({ default_text = visual_selection })
    else
        require("telescope.builtin").grep_string()
    end
end

require("lazy").setup({
    {
        "folke/which-key.nvim",
        config = function()
            require("which-key").setup({})
        end,
    },
    { "folke/neoconf.nvim", cmd = "Neoconf" },
    {
        "ojroques/nvim-osc52",
        keys = {
            { "<leader>y", function() require('osc52').copy_visual() end, silent = true, noremap = true, mode = "v" },
        },
        config = function()
            require('osc52').setup {
                trim = false,             -- Trim surrounding whitespaces before copy
                tmux_passthrough = true,  -- Use tmux passthrough (requires tmux: set -g allow-passthrough on)
            }
        end,
    },
    {'nvim-tree/nvim-web-devicons', lazy = true},
    "folke/neodev.nvim",
    { "UtkarshVerma/molokai.nvim", lazy = false, priority = 1000, config = function() vim.cmd[[colorscheme molokai]] end },
    -- { "rebelot/kanagawa.nvim", lazy = false, priority = 1000, config = function() vim.cmd[[ colorscheme kanagawa]] end },
    {
        "dstein64/vim-startuptime",
        -- lazy-load on a command
        cmd = "StartupTime",
        -- init is called during startup. Configuration for vim plugins typically should be set in an init function
        init = function()
            vim.g.startuptime_tries = 10
        end,
    },
    {
      "nvim-lualine/lualine.nvim",
        event = "VeryLazy",
        opts = function(_, opts)
            sections = {
                -- lualine_x = { 'copilot' ,'encoding', 'fileformat', 'filetype' },
                lualine_x = { 'encoding', 'fileformat', 'filetype' },
                lualine_z = { 'location', 'tabs' }
            }
            opts.sections = sections
        end,
        dependencies = { "AndreM222/copilot-lualine" },
    },

    -- telescope
    {
        'nvim-telescope/telescope.nvim',
        version = '0.1.5',
        keys = {
            {"<leader>f", ":Telescope find_files<CR>", silent = true, noremap = true,},
            {"<leader>fg", ":Telescope live_grep<CR>", silent = true, noremap = true,},
            {"<leader>fs", ":lua telescope_grep_string()<CR>", silent = true, noremap = true,},
            {"<leader>fs", ":lua telescope_grep_string()<CR>", silent = true, noremap = true, mode = "v"},
            {"<leader>b", ":Telescope buffers<CR>", silent = true, noremap = true,},
            {"<leader>fh", ":Telescope help_tags<CR>", silent = true, noremap = true,},
        },
        dependencies = {
            'nvim-lua/plenary.nvim',
            'nvim-lua/popup.nvim',
            {
                'nvim-telescope/telescope-file-browser.nvim',
                config = function()
                    require'telescope'.load_extension('file_browser')
                end,
            },
        },
    },

    {
        'gaborvecsei/memento.nvim',
        keys = {
            {
                "<leader>mh", function()
                    require('memento').toggle()
                end, silent = true, noremap = true },
        },
    },
    {
        'dyng/ctrlsf.vim',
        keys = {
            { "<leader>sf", "<Plug>CtrlSFPrompt" },
            { "<leader>ss", "<Plug>CtrlSFCwordPath" },
            { "<leader>st", ":CtrlSFToggle<CR>" },
        },
    },
    {
        'nvim-tree/nvim-tree.lua',
        keys={
            { "<leader>tt", ":NvimTreeFindFileToggle<CR>", silent = true, noremap = true },
        },
        config = function()
            require'nvim-tree'.setup()
        end,
    },
    {
        "hedyhli/outline.nvim",
        lazy = true,
        cmd = { "Outline", "OutlineOpen" },
        keys = { -- Example mapping to toggle outline
            { "<leader>ts", "<cmd>Outline<CR>", desc = "Toggle outline" },
        },
        opts = {
            -- Your setup opts here
        },
    },
    -- {
    --     'liuchengxu/vista.vim',
    --     keys = {
    --         { "<leader>ts", ":Vista!!<CR>", silent = true, noremap = true },
    --     },
    -- },
    'tpope/vim-sleuth',
    {
        'zivyangll/git-blame.vim',
        lazy = false,
    },
    {
        'rust-lang/rust.vim',
        ft = { "rust" },
    },
    {
        'akinsho/bufferline.nvim', 
        version = "*", 
        dependencies = 'nvim-tree/nvim-web-devicons',
        event = "BufReadPost",
        config = function() 
            require("bufferline").setup{
                options = {
                    always_show_bufferline = false,
                    close_command = "Bdelete! %d"
                },
            }
        end
    },
    {
        'akinsho/toggleterm.nvim',
        event = "TermEnter",
        cmd = { "ToggleTerm" },
        config = function()
            require("toggleterm").setup()
        end
    },
    {
        "lewis6991/gitsigns.nvim",
        config = function()
            require("gitsigns").setup{
                on_attach = function(bufnr)
                    local gitsigns = require('gitsigns')

                    local function map(mode, l, r, opts)
                        opts = opts or {}
                        opts.buffer = bufnr
                        vim.keymap.set(mode, l, r, opts)
                    end

                    -- Navigation
                    map('n', ']c', function()
                        if vim.wo.diff then
                         vim.cmd.normal({']c', bang = true})
                        else
                            gitsigns.next_hunk()
                        end
	            end)

                    map('n', '[c', function()
                        if vim.wo.diff then
                            vim.cmd.normal({'[c', bang = true})
                        else
                            gitsigns.prev_hunk()
                        end
                    end)

                    -- Actions
                    map('n', '<leader>hs', gitsigns.stage_hunk)
                    map('n', '<leader>hr', gitsigns.reset_hunk)
                    map('v', '<leader>hs', function() gitsigns.stage_hunk {vim.fn.line('.'), vim.fn.line('v')} end)
                    map('v', '<leader>hr', function() gitsigns.reset_hunk {vim.fn.line('.'), vim.fn.line('v')} end)
                    map('n', '<leader>hS', gitsigns.stage_buffer)
                    map('n', '<leader>hu', gitsigns.undo_stage_hunk)
                    map('n', '<leader>hR', gitsigns.reset_buffer)
                    map('n', '<leader>hp', gitsigns.preview_hunk)
                    map('n', '<leader>hb', function() gitsigns.blame_line{full=true} end)
                    map('n', '<leader>tb', gitsigns.toggle_current_line_blame)
                    map('n', '<leader>hd', gitsigns.diffthis)
                    map('n', '<leader>hD', function() gitsigns.diffthis('~') end)
                    map('n', '<leader>td', gitsigns.toggle_deleted)

                    -- Text object
                    map({'o', 'x'}, 'ih', ':<C-U>Gitsigns select_hunk<CR>')
                end
            }
        end,
    },
    {
        "nvim-treesitter/nvim-treesitter",
        version = false, -- last release is way too old and doesn't work on Windows
        build = ":TSUpdate",
        event = { "BufReadPost", "BufNewFile" },
        cmd = { "TSUpdateSync" },
        keys = {
            { "<CR>", desc = "Increment selection", mode = "x" },
            { "<bs>", desc = "Decrement selection", mode = "x" },
        },
        ---@type TSConfig
        opts = {
            highlight = {
                enable = true,
                disable = { "lua", },
            },
            indent = { enable = true },
            ensure_installed = {
                "c",
                "cpp",
                "python",
                "rust"
            },
            incremental_selection = {
                enable = true,
                keymaps = {
                    init_selection = '<CR>',
                    scope_incremental = '<CR>',
                    node_incremental = '<TAB>',
                    node_decremental = '<bs>',
                },
            },
        },
        ---@param opts TSConfig
        config = function(_, opts)
            if type(opts.ensure_installed) == "table" then
                ---@type table<string, boolean>
                local added = {}
                opts.ensure_installed = vim.tbl_filter(function(lang)
                    if added[lang] then
                        return false
                    end
                    added[lang] = true
                    return true
                    end, opts.ensure_installed)
            end
            require("nvim-treesitter.configs").setup(opts)
        end,
    },
    {
        'nvim-treesitter/nvim-treesitter-context',
        event = "VeryLazy",
        opts = {
                max_lines = 10,
                trim_scope = 'inner',
        },
        dependencies = {
            "nvim-treesitter/nvim-treesitter",
        },
    },

    {
        'sindrets/diffview.nvim',
        cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewToggleFiles", "DiffviewFocusFiles" },
        opts = function(_, opts)
            local actions = require("diffview.actions")
            opts.keymaps = {
                disable_defaults = true,
                view = {
                    { "n", "<leader>bb", actions.toggle_files, { desc = "Toggle the file panel." } },
                    { "n", "<leader>j",       actions.select_next_entry,              { desc = "Open the diff for the next file" } },
                    { "n", "<leader>k",     actions.select_prev_entry,              { desc = "Open the diff for the previous file" } },
                    { "n", "gf",          actions.goto_file_edit,                 { desc = "Open the file in the previous tabpage" } },
                    { "n", "<C-w><C-f>",  actions.goto_file_split,                { desc = "Open the file in a new split" } },
                    { "n", "<C-w>gf",     actions.goto_file_tab,                  { desc = "Open the file in a new tabpage" } },
                    { "n", "<leader>e",   actions.focus_files,                    { desc = "Bring focus to the file panel" } },
                    { "n", "g<C-x>",      actions.cycle_layout,                   { desc = "Cycle through available layouts." } },
                    { "n", "[x",          actions.prev_conflict,                  { desc = "In the merge-tool: jump to the previous conflict" } },
                    { "n", "]x",          actions.next_conflict,                  { desc = "In the merge-tool: jump to the next conflict" } },
                    { "n", "<leader>co",  actions.conflict_choose("ours"),        { desc = "Choose the OURS version of a conflict" } },
                    { "n", "<leader>ct",  actions.conflict_choose("theirs"),      { desc = "Choose the THEIRS version of a conflict" } },
                    { "n", "<leader>cb",  actions.conflict_choose("base"),        { desc = "Choose the BASE version of a conflict" } },
                    { "n", "<leader>ca",  actions.conflict_choose("all"),         { desc = "Choose all the versions of a conflict" } },
                    { "n", "dx",          actions.conflict_choose("none"),        { desc = "Delete the conflict region" } },
                    { "n", "<leader>cO",  actions.conflict_choose_all("ours"),    { desc = "Choose the OURS version of a conflict for the whole file" } },
                    { "n", "<leader>cT",  actions.conflict_choose_all("theirs"),  { desc = "Choose the THEIRS version of a conflict for the whole file" } },
                    { "n", "<leader>cB",  actions.conflict_choose_all("base"),    { desc = "Choose the BASE version of a conflict for the whole file" } },
                    { "n", "<leader>cA",  actions.conflict_choose_all("all"),     { desc = "Choose all the versions of a conflict for the whole file" } },
                    { "n", "dX",          actions.conflict_choose_all("none"),    { desc = "Delete the conflict region for the whole file" } },
                },
                diff1 = {
                    -- Mappings in single window diff layouts
                    { "n", "g?", actions.help({ "view", "diff1" }), { desc = "Open the help panel" } },
                },
                diff2 = {
                    -- Mappings in 2-way diff layouts
                    { "n", "g?", actions.help({ "view", "diff2" }), { desc = "Open the help panel" } },
                },
                diff3 = {
                    -- Mappings in 3-way diff layouts
                    { { "n", "x" }, "2do",  actions.diffget("ours"),            { desc = "Obtain the diff hunk from the OURS version of the file" } },
                    { { "n", "x" }, "3do",  actions.diffget("theirs"),          { desc = "Obtain the diff hunk from the THEIRS version of the file" } },
                    { "n",          "g?",   actions.help({ "view", "diff3" }),  { desc = "Open the help panel" } },
                },
                diff4 = {
                    -- Mappings in 4-way diff layouts
                    { { "n", "x" }, "1do",  actions.diffget("base"),            { desc = "Obtain the diff hunk from the BASE version of the file" } },
                    { { "n", "x" }, "2do",  actions.diffget("ours"),            { desc = "Obtain the diff hunk from the OURS version of the file" } },
                    { { "n", "x" }, "3do",  actions.diffget("theirs"),          { desc = "Obtain the diff hunk from the THEIRS version of the file" } },
                    { "n",          "g?",   actions.help({ "view", "diff4" }),  { desc = "Open the help panel" } },
                },
            }
        end,
    },
    {
        'neoclide/coc.nvim',
        branch = "release",
        lazy = false,
    },
    {
        'aliou/bats.vim',
        ft = "bat",
    },
    {
        "ray-x/lsp_signature.nvim",
        event = "VeryLazy",
        opts = {},
        config = function(_, opts) require'lsp_signature'.setup(opts) end
    },
    {
        'github/copilot.vim',
        lazy = false,
        config = function()
            local keyset = vim.keymap.set
            keyset('i', '<C-k>', 'copilot#Accept("\\<CR>")', {
                expr = true,
                noremap = true,
                desc = "Accept copilot suggestion",
                replace_keycodes = false
            })
            vim.g.copilot_no_tab_map = true
        end,
    },
    -- { 'AndreM222/copilot-lualine' },
    -- {
    --     'zbirenbaum/copilot.lua',
    --     cmd = { "Copilot" },
    --     event = "InsertEnter",
    --     opts = {
    --         suggestion = {
    --             auto_trigger = true,
    --             keymap = {
    --                 accept = "<C-k>",
    --                 accept_word = false,
    --                 accept_line = false,
    --                 next = "<M-]>",
    --                 prev = "<M-[>",
    --                 dismiss = "<C-]>",
    --             },
    --         },
    --     },
    -- },
    {
        "mhinz/vim-startify",
    },
    {
        'rmagatti/auto-session',
        config = true,
        opts = {
            pre_save_cmds = {
                function()
                    require"nvim-tree.api".tree.close()
                    require"outline".close()
                end
            },
        }
    },
    {
        'renerocksai/telekasten.nvim',
        dependencies = {'nvim-telescope/telescope.nvim'},
        config = function()
            require('telekasten').setup({
                home = vim.fn.expand("~/notes"), -- Put the name of your notes directory here
            })
        end
    },
    {
        "lukas-reineke/indent-blankline.nvim",
        main = "ibl",
        config = function()
            vim.opt.list = true
            vim.api.nvim_command([[
              set listchars=tab:⤏\ ,trail:·
            ]])

            require('ibl').setup({
                whitespace = {
                    remove_blankline_trail = true,
                },
            })

        end,
    },
    {
        'famiu/bufdelete.nvim',
    },
    {
        "chrisgrieser/nvim-rip-substitute",
        cmd = "RipSubstitute",
        keys = {
            {
                "<leader>fr",
                function() require("rip-substitute").sub() end,
                mode = { "n", "x" },
                desc = " rip substitute",
            },
        },
        opts = {
            regexOptions = {
                pcre2 = false,
            },
        },
    },
})

vim.cmd([[

syntax enable
filetype plugin indent on
set hlsearch

" Fix auto-indentation for YAML files
augroup yaml_fix
autocmd!
autocmd FileType yaml setlocal ts=2 sts=2 sw=2 expandtab indentkeys-=0# indentkeys-=<:>
augroup END

" show signcolumn
set signcolumn=yes:1

function ToggleCopymode()
    if &signcolumn == 'yes:1'
        set signcolumn=no
        set nolist
        " execute "MiniMapClose"
        " execute "SymbolsOutlineClose"
    else
        set signcolumn=yes:1
        set list
        "execute "MiniMapOpen"
    endif
endfunction

nnoremap <silent> <Leader>uc :call ToggleCopymode()<CR>

" switch the buffer
nnoremap <silent>    <S-TAB> <Cmd>bprev<CR>
nnoremap <silent>    <TAB> <Cmd>bnext<CR>

nnoremap <silent>    <A-1> <Cmd>b 1<CR>
nnoremap <silent>    <A-2> <Cmd>b 2<CR>
nnoremap <silent>    <A-3> <Cmd>b 3<CR>
nnoremap <silent>    <A-4> <Cmd>b 4<CR>
nnoremap <silent>    <A-5> <Cmd>b 5<CR>
nnoremap <silent>    <A-6> <Cmd>b 6<CR>
nnoremap <silent>    <A-7> <Cmd>b 7<CR>
nnoremap <silent>    <A-8> <Cmd>b 8<CR>
nnoremap <silent>    <A-9> <Cmd>b 9<CR>
nnoremap <silent>    <A-`> <Cmd>b#<CR>

nnoremap <silent>    <A-c> <Cmd>Bdelete<CR>

" undo dir
if !isdirectory("/tmp/nvim_bak")
call mkdir("/tmp/nvim_bak", "", 0700)
endif
set undodir=/tmp/nvim_bak
set undofile

" restore last cursor position
autocmd BufReadPost *
\ if line("'\"") >= 1 && line("'\"") <= line("$") |
\   exe "normal! g`\"" |
\ endif

" git gutter
set updatetime=100

" Exit from terminal mode
tnoremap <Esc> <C-\><C-n>

" Toggle terminal
autocmd TermEnter term://*toggleterm#*
\ tnoremap <silent><c-j> <Cmd>exe v:count1 . "ToggleTerm"<CR>

" By applying the mappings this way you can pass a count to your
" mapping to open a specific window.
" For example: 2<C-t> will open terminal 2
nnoremap <silent><c-j> <Cmd>exe v:count1 . "ToggleTerm"<CR>
inoremap <silent><c-j> <Esc><Cmd>exe v:count1 . "ToggleTerm"<CR>

" git blame
nnoremap ,b :<C-u>call gitblame#echo()<CR>

if has('unix')
    set dictionary+=/usr/share/dict/words
else
    set dictionary+=~/AppData/Local/nvim/words
endif

]])

-- mini.map
-- require('mini.map').setup()
-- vim.keymap.set('n', '<Leader>mo', MiniMap.open)
-- vim.keymap.set('n', '<Leader>mc', MiniMap.close)
-- vim.cmd([[ autocmd VimEnter * lua MiniMap.open() ]])
-- vim.api.nvim_create_user_command('MiniMapOpen', 'lua MiniMap.open()', {})
-- vim.api.nvim_create_user_command('MiniMapClose', 'lua MiniMap.close()', {})

-- Global mappings.
vim.keymap.set('n', '<leader>e', vim.diagnostic.open_float)
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist)

local diffopened = false
function diffview_toggle()
    if diffopened then
        diffopened = false
        vim.cmd([[:DiffviewClose]])
    else
        diffopened = true
        vim.cmd([[:DiffviewOpen]])
    end
end
vim.keymap.set('n', '<leader>d', diffview_toggle)


-- Having longer updatetime (default is 4000 ms = 4s) leads to noticeable
-- delays and poor user experience
vim.opt.updatetime = 300
local keyset = vim.keymap.set
-- Autocomplete
function _G.check_back_space()
    local col = vim.fn.col('.') - 1
    return col == 0 or vim.fn.getline('.'):sub(col, col):match('%s') ~= nil
end

-- Use Tab for trigger completion with characters ahead and navigate
-- NOTE: There's always a completion item selected by default, you may want to enable
-- no select by setting `"suggest.noselect": true` in your configuration file
-- NOTE: Use command ':verbose imap <tab>' to make sure Tab is not mapped by
-- other plugins before putting this into your config
local opts = {silent = true, noremap = true, expr = true, replace_keycodes = false}
keyset("i", "<TAB>", 'coc#pum#visible() ? coc#pum#next(1) : "<TAB>"', opts)
keyset("i", "<S-TAB>", [[coc#pum#visible() ? coc#pum#prev(1) : "\<C-h>"]], opts)

-- Make <CR> to accept selected completion item or notify coc.nvim to format
-- <C-g>u breaks current undo, please make your own choice
keyset("i", "<cr>", [[coc#pum#visible() ? coc#pum#confirm() : "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"]], opts)

-- Use <c-space> to trigger completion
keyset("i", "<c-space>", "coc#refresh()", {silent = true, expr = true})

-- Use `[g` and `]g` to navigate diagnostics
-- Use `:CocDiagnostics` to get all diagnostics of current buffer in location list
keyset("n", "[d", "<Plug>(coc-diagnostic-prev)", {silent = true})
keyset("n", "]d", "<Plug>(coc-diagnostic-next)", {silent = true})

-- GoTo code navigation
keyset("n", "gd", "<Plug>(coc-definition)", {silent = true})
keyset("n", "gy", "<Plug>(coc-type-definition)", {silent = true})
keyset("n", "gi", "<Plug>(coc-implementation)", {silent = true})
keyset("n", "gr", "<Plug>(coc-references)", {silent = true})


-- Use K to show documentation in preview window
function _G.show_docs()
    local cw = vim.fn.expand('<cword>')
    if vim.fn.index({'vim', 'help'}, vim.bo.filetype) >= 0 then
        vim.api.nvim_command('h ' .. cw)
    elseif vim.api.nvim_eval('coc#rpc#ready()') then
        vim.fn.CocActionAsync('doHover')
    else
        vim.api.nvim_command('!' .. vim.o.keywordprg .. ' ' .. cw)
    end
end
keyset("n", "K", '<CMD>lua _G.show_docs()<CR>', {silent = true})


-- Highlight the symbol and its references on a CursorHold event(cursor is idle)
vim.api.nvim_create_augroup("CocGroup", {})
vim.api.nvim_create_autocmd("CursorHold", {
    group = "CocGroup",
    command = "silent call CocActionAsync('highlight')",
    desc = "Highlight symbol under cursor on CursorHold"
})


-- Symbol renaming
keyset("n", "<leader>rn", "<Plug>(coc-rename)", {silent = true})


-- Formatting selected code
keyset("x", "<leader>F", "<Plug>(coc-format-selected)", {silent = true})
keyset("n", "<leader>F", "<Plug>(coc-format-selected)", {silent = true})


-- Setup formatexpr specified filetype(s)
vim.api.nvim_create_autocmd("FileType", {
    group = "CocGroup",
    pattern = "typescript,json",
    command = "setl formatexpr=CocAction('formatSelected')",
    desc = "Setup formatexpr specified filetype(s)."
})

-- Update signature help on jump placeholder
vim.api.nvim_create_autocmd("User", {
    group = "CocGroup",
    pattern = "CocJumpPlaceholder",
    command = "call CocActionAsync('showSignatureHelp')",
    desc = "Update signature help on jump placeholder"
})

-- Apply codeAction to the selected region
-- Example: `<leader>aap` for current paragraph
local opts = {silent = true, nowait = true}
keyset("x", "<leader>a", "<Plug>(coc-codeaction-selected)", opts)
keyset("n", "<leader>a", "<Plug>(coc-codeaction-selected)", opts)

-- Remap keys for apply code actions at the cursor position.
keyset("n", "<leader>ac", "<Plug>(coc-codeaction-cursor)", opts)
-- Remap keys for apply source code actions for current file.
keyset("n", "<leader>as", "<Plug>(coc-codeaction-source)", opts)
-- Run the Code Lens actions on the current line
keyset("n", "<leader>al", "<Plug>(coc-codelens-action)", opts)

-- Apply the most preferred quickfix action on the current line.
keyset("n", "<leader>qf", "<Plug>(coc-fix-current)", opts)

-- Remap keys for apply refactor code actions.
keyset("n", "<leader>re", "<Plug>(coc-codeaction-refactor)", { silent = true })
keyset("x", "<leader>r", "<Plug>(coc-codeaction-refactor-selected)", { silent = true })
keyset("n", "<leader>r", "<Plug>(coc-codeaction-refactor-selected)", { silent = true })


-- Map function and class text objects
-- NOTE: Requires 'textDocument.documentSymbol' support from the language server
keyset("x", "if", "<Plug>(coc-funcobj-i)", opts)
keyset("o", "if", "<Plug>(coc-funcobj-i)", opts)
keyset("x", "af", "<Plug>(coc-funcobj-a)", opts)
keyset("o", "af", "<Plug>(coc-funcobj-a)", opts)
keyset("x", "ic", "<Plug>(coc-classobj-i)", opts)
keyset("o", "ic", "<Plug>(coc-classobj-i)", opts)
keyset("x", "ac", "<Plug>(coc-classobj-a)", opts)
keyset("o", "ac", "<Plug>(coc-classobj-a)", opts)


-- Remap <C-f> and <C-b> to scroll float windows/popups
---@diagnostic disable-next-line: redefined-local
local opts = {silent = true, nowait = true, expr = true}
keyset("n", "<C-f>", 'coc#float#has_scroll() ? coc#float#scroll(1) : "<C-f>"', opts)
keyset("n", "<C-b>", 'coc#float#has_scroll() ? coc#float#scroll(0) : "<C-b>"', opts)
keyset("i", "<C-f>",
       'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(1)<cr>" : "<Right>"', opts)
keyset("i", "<C-b>",
       'coc#float#has_scroll() ? "<c-r>=coc#float#scroll(0)<cr>" : "<Left>"', opts)
keyset("v", "<C-f>", 'coc#float#has_scroll() ? coc#float#scroll(1) : "<C-f>"', opts)
keyset("v", "<C-b>", 'coc#float#has_scroll() ? coc#float#scroll(0) : "<C-b>"', opts)

-- Use CTRL-S for selections ranges
-- Requires 'textDocument/selectionRange' support of language server
keyset("n", "<C-s>", "<Plug>(coc-range-select)", {silent = true})
keyset("x", "<C-s>", "<Plug>(coc-range-select)", {silent = true})


-- Add `:Format` command to format current buffer
vim.api.nvim_create_user_command("Format", "call CocAction('format')", {})

-- " Add `:Fold` command to fold current buffer
vim.api.nvim_create_user_command("Fold", "call CocAction('fold', <f-args>)", {nargs = '?'})

-- Add `:OR` command for organize imports of the current buffer
vim.api.nvim_create_user_command("OR", "call CocActionAsync('runCommand', 'editor.action.organizeImport')", {})

-- Add (Neo)Vim's native statusline support
-- NOTE: Please see `:h coc-status` for integrations with external plugins that
-- provide custom statusline: lightline.vim, vim-airline
vim.opt.statusline:prepend("%{coc#status()}%{get(b:,'coc_current_function','')}")

-- Mappings for CoCList
-- code actions and coc stuff
---@diagnostic disable-next-line: redefined-local
local opts = {silent = true, nowait = true}
-- Show all diagnostics
keyset("n", ",a", ":<C-u>CocList diagnostics<cr>", opts)
-- Manage extensions
keyset("n", ",e", ":<C-u>CocList extensions<cr>", opts)
-- Show commands
keyset("n", "<leader>p", ":<C-u>CocList commands<cr>", opts)
-- Find symbol of current document
keyset("n", "<leader>o", ":<C-u>CocList outline<cr>", opts)
-- Search workspace symbols
keyset("n", "cs", ":<C-u>CocList -I symbols<cr>", opts)
-- Do default action for next item
keyset("n", "<space>j", ":<C-u>CocNext<cr>", opts)
-- Do default action for previous item
keyset("n", "<space>k", ":<C-u>CocPrev<cr>", opts)

-- change default coc snippet key bindings
vim.g.coc_snippet_next = '<TAB>'
vim.g.coc_snippet_prev = '<S-TAB>'

-- short cut for note taking
keyset("n", "<leader>n", ":Telekasten<CR>", opts)

-- markdown
vim.g.markdown_fenced_languages = { "javascript", "bash", "diff", "go", "rust", "c" }
