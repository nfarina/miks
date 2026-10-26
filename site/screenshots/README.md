# The website's screenshots

Every screenshot in `site/img` is the real UI running against a made-up daemon (`demo.js`), which provides the workspaces, terminal screens (as VT sequences, drawn to the terminal's width), conversations and files.

## Mac, iPhone and iPad

```bash
(cd packages/ui && npx vite --port 4810)
node site/screenshots/capture.mjs            # every scene
node site/screenshots/capture.mjs mac-chat   # or some
```

`capture.mjs` runs headless Chrome. For the Mac it stands in for Electron's preload; for the phone and iPad it swaps `WebSocket` under the iOS app's bridge. It then draws the window buttons or the status bar over each shot.

- Chrome's scale comes from `--force-device-scale-factor`, one Chrome per scale. With the scale emulated instead (`setDeviceMetricsOverride`), xterm.js's WebGL renderer drew every glyph at twice its cell's size.
- Each scene is set up through its data (`scenes` in `demo.js`, e.g. a workspace's `activeTabId`), not with clicks. Synthetic clicks don't reach handlers that listen for pointer events.
- A tab's panel shows a file only if `file` is set as well as `files`, since `hasPanel` looks at `file`.

## iPhone Duo

The Duo shot is the iOS app itself in the simulator, loading `app.html` from the same Vite:

1. Copy `app.html` to `packages/ui/demo.html`. Vite serves only from there, and `/@fs/` in it points at this checkout's `demo.js`. Delete it afterwards.
2. Build and install: `ios/build.sh sim`, then `xcrun simctl install <udid> ios/build/DerivedData.noindex/Build/Products/Debug-iphonesimulator/Miks.app`.
3. Point the app at the page:
   `xcrun simctl spawn <udid> defaults write com.nfarina.miks.ios use_development_server -bool YES`,
   `development_server "http://localhost:4810/demo.html?storage=…&demo=…"` (URL-encoded JSON, as in `capture.mjs`'s scenes, with `"noHardwareKeyboard": true`),
   and `use_cached_web_bundle -bool NO`, or it fetches `bundle.json` from that URL instead.
4. Unfold the Duo in Xcode's Device Hub (simctl can't), launch the app, and tap the terminal. WKWebView raises the keyboard only for a real tap. The simulator counts the Mac's keyboard as a hardware one, which hides the key bar, so the demo keeps telling the page there is none.
5. Screenshot the inner screen, the 2007×2853 one in `xcrun simctl io <udid> enumerate`. Its UUID changes with every boot:
   `xcrun simctl io <udid> screenshot --display=<uuid> --mask=alpha duo.png`, then resize it to 1338 wide.
6. Delete the three defaults afterwards.

Save it as `site/img/duo.png`, then `node site/screenshots/capture.mjs duo-laptop` folds it into laptop pose (`duo-pose.html`) as `site/img/duo-laptop.png`. That's an image rather than CSS on the page, because browsers disagreed about the 3D transform.
