# CodeArts complete implementation handoff

Give Opus this entire extracted folder and the prompt below.

> Implement the CodeArts Pixel Workshop redesign across Office, the Lanes homescreen, and lane details. Read this guide, then office/Pixel_Workshop_Design_Spec.md and lanes/START_HERE.md. Inspect the existing repo and reuse its routing, state, commands, permissions, and rendering logic where appropriate. Implement the shared design system and all three surfaces, integrate the provided sprite animations with confirmed live events, and verify the acceptance checks from both specifications. Report changed files, actual event mappings, checks run, and any remaining gaps.

## Read in this order

1. This guide sets the combined scope and resolves older visual differences.
2. office/Pixel_Workshop_Design_Spec.md defines Office v2, popover behavior, animation and integration.
3. office/README.md explains the room, sprite atlases, timing manifest, editable sprite source and demo fixture.
4. lanes/START_HERE.md defines the Lanes home, lane details, evidence tabs and existing controls.
5. Review the mockups and play office/Pixel_Workshop_Motion_Study.mp4.

## Final design decisions

- Office opens as a full-width animated workshop. Pressing an agent opens a compact floating window. It can switch agents or close without resizing the room.
- The original office art direction image is included for its visual style. Its docked inspector was superseded by the Office v2 specification and motion study.
- Lanes uses a persistent navigation rail on desktop, a plan homescreen, and full-page lane details. The Office floating window and Lanes detail route serve their respective views.
- The lifecycle strip and evidence tabs operate independently. Build can remain the current phase while Brief is selected.
- All surfaces share plum panels, lavender selection, readable status labels and the same role sprites.
- Use the included atlases and frame durations as starter animation assets. The editable source is office/build_sprites.py. The motion study is a scripted demonstration, and live event wiring must be verified against the actual repo.
- Generated mockups abbreviate content. Expose full source text in implementation. Keep global counts fully visible, including the Brief reference's clipped rightmost label.

## Package map

| Folder or file | Contents |
|---|---|
| office/ | Office v2 spec, asset guide, clean room PNG, four transparent role atlases, editable Python sprite source, frame manifest, scene fixture and motion study |
| office/Approved_Office_Art_Direction.png | Original approved pixel-art style reference |
| lanes/ | Implementation instructions, approved homescreen, Transcript and Brief detail mockups, original detail screenshots |
| FILE_MANIFEST.json | Relative paths, byte sizes and SHA-256 checksums |

## Implementation sequence

Inspect the actual repo entry points first. Establish shared tokens and navigation, implement the Office stage and floating window, then the Lanes home and detail surfaces. Connect live state and existing command handlers, add motion and reduced-motion behavior, and run the checks required by the repo and both specs. Exercise a real run, deep links, follow-live off/on, evidence switching during updates, missing metadata, keyboard navigation, narrow layouts and asynchronous steering.

The package consolidates the latest Office and Lanes handoffs. It contains design materials and starter art, with repository integration to be performed by Opus.
