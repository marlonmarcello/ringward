# Changelog

## 0.1.14

### Patch Changes

- 2d56ae8: Open the configured save directory when multiple Steam accounts have saves, including accounts that only have modded saves.
- 2d56ae8: Ringward now remembers its window size, position, and maximized state between launches.
- 2d56ae8: Windows releases now offer a setup wizard alongside the portable ZIP, with SHA-256 checksums for both downloads.

## 0.1.13

### Patch Changes

- b1cf9c9: Rename or delete save backups and open individual snapshot folders from Manage. Restore now preserves all current saves in a Before restore snapshot, and the Save backups page can open the main save folder directly.
- 05a978d: Enter a load-order position directly and apply it with Enter or by leaving the field. Asset overrides now show one row per mod, with load-order numbers and a winner for each file. Regulation review compares competing values side by side and groups source versions, CSV tables, and change counts in a separate inputs table.

## [0.1.12] - 2026-11-08

First GitHub release of Ringward for Steam Elden Ring on Windows x64.

- Manage separate gameplay profiles, drag to reorder mods, search or filter the library, and switch to the built-in Vanilla profile.
- Import ZIP, supported 7z or RAR, and extracted mods with asset detection, duplicate checks, and import diagnostics.
- Review competing regulation edits and build a merged `regulation.bin` from binary mods and Smithbox CSV patches.
- Import Elden Sliders and Elden Bling Sliders JSON, manage in-game Favorites, and open image-based slider guides.
- Back up and restore saves, isolate profile saves, and automatically back up saves before Favorites edits.
- Install ReShade, select visual presets independently of gameplay, and retain tutorial progress and preset changes.
- Use Nexus Mods file lookup and download integration in the development preview.
- Use the branded Windows app and control startup logos on ME3 launches.

[0.1.12]: https://github.com/marlonmarcello/ringward/releases/tag/v0.1.12
