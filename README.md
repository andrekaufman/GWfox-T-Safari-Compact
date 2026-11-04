<h1 align="center">GWfox-T Safari Compact</h1>

<p align="center">
  An evolution and reimplementation of <a href="https://github.com/akkva/GWfox-T">GWfox-T's</a> optional Compact mode
</p>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/190e4d4d-f026-487f-8492-b94588453834"
    alt="GWfox-T Safari Compact preview"
    width="1280">
</p>

## What's different?

- **The selected tab becomes the real URL bar**  
  Click the active tab or press `Cmd+L` to edit Firefox's actual address field directly inside it.

- **Adaptive tab shelf**  
  The scrolling shelf is done away with, and Safari's system is ported over. It continuously redistributes the available space and responds dynamically to changes.

- **Custom animations**  
  Custom, handcrafted animations are included for opening, closing, switching, loading and editing the URL.
  
- **Custom loading behaviour**  
  Favicons transition gracefully back and forth within the tab upon highlight. A loading indicator connected to Firefox's real page-loading state is also present.

- **Integrated browser controls**  
  Back, forward, reload and close controls appear when relevant and tucks away when not needed.

- **Liquid Glass translated to CSS**  
  Safari's material system is recreated with layered radial and linear highlights, translucent fills, inset reflections, fine edge lighting, state-specific shadows and more. All built in CSS!

  
## Relationship to GWfox-T

Most of Upstream's code remains intact. This fork mainly adds two files on top:

- `safariCompact.css` for the rebuilt Compact layout, styling and animations
- `JS/safariCompact.uc.js` for the tab shelf, URL bar integration and browser interaction

## Installation

Safari Compact is currently only tested on Firefox on macOS 27 Golden Gate.

1. Install [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) by following its own instructions.

2. Move the theme files into your Firefox profile's `chrome` folder:

```text
<Firefox profile>/
└── chrome/
    ├── userChrome.css
    ├── userContent.css
    ├── safariCompact.css
    └── JS/
        └── safariCompact.uc.js
```

3. Set the following preferences in `about:config`:

| Preference | Value |
| :--- | :--- |
| `toolkit.legacyUserProfileCustomizations.stylesheets` | `true` |
| `svg.context-properties.content.enabled` | `true` |
| `browser.nova.enabled` | `false` |
| `browser.newtabpage.activity-stream.nova.enabled` | `false` |
| `userChromeJS.enabled` | `true` |
| `gwt.oneliner` | `true` |

> [!WARNING]
> `safariCompact.uc.js` runs with privileged access to Firefox. A comprehensive security review of the project found no vulnerabilities in the code provided here, but did not cover fx-autoconfig or other external loaders. Review privileged scripts before installing them and only use files from sources you trust.

## Customization

Unlike the original GWfox-T theme, Safari Compact currently has no optional layouts or supported customization flags since it aims to be as close to Safari as possible.

However, Adaptive Tab Bar Colour is supported. Set gwt.atbc to true in about:config if you wish to use the extension. More options may come later, and PRs are welcome!

## Known issues

- Text in inactive tabs may be very slightly off-center when both front/back buttons are present
- New tab-animation needs further polish

## Credits

Built on [GWfox-T](https://github.com/akkva/GWfox-T) by [akkva](https://github.com/akkva). Thanks for the great foundation to build upon!

## License

Licensed under the [Mozilla Public License 2.0](LICENSE).
