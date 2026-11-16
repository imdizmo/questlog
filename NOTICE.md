# Notices

Questlog is released under the MIT licence (see `LICENSE`). It includes or ships with the following third-party work,
each under its own licence.

## Space Grotesk (font)

`web/public/fonts/SpaceGrotesk_*.ttf`, copyright 2020 The Space Grotesk Project Authors
(<https://github.com/floriankarsten/space-grotesk>). Licensed under the SIL Open Font License 1.1; the full text is in
`web/public/fonts/OFL.txt` and ships with the built web app.

## Node.js (desktop runtime)

The desktop archives bundle an unmodified Node.js binary as `runtime/node` (`runtime/node.exe` on Windows). Node.js is
licensed under the MIT licence and includes third-party components under their own licences. Its full `LICENSE` file
ships next to the binary as `runtime/LICENSE` in every archive.

## Tauri (desktop shell)

The desktop window (`desktop/src-tauri`) is built with Tauri (<https://tauri.app>), dual-licensed under MIT or
Apache-2.0. The other Rust crates compiled into the `Questlog` binary are listed in `desktop/src-tauri/Cargo.lock`;
each carries its own licence (mostly MIT and/or Apache-2.0). Every archive lists them, with version and licence, in
`THIRD-PARTY-RUST.txt`.

## npm dependencies

The server bundle (`server/server.mjs` in the archives) and the web app inline the npm packages listed in
`package.json` (among them Fastify, React, Yjs, Zod and markdown-it), each under its own licence (MIT or similar, as
stated in each package). The licence comments of the packages in the server bundle ship beside it as
`server/server.mjs.LEGAL.txt`. The packages inlined into the web app are listed with their full licence texts in
`web/THIRD-PARTY-WEB.txt`, written by the build. The archives also carry this file and `LICENSE`.

## Icons

The Questlog icon (`desktop/src-tauri/icons/`) is original work, under this project's MIT licence.
