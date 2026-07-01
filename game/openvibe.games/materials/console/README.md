# OpenVibe loading background

Source's full-screen loading background is a VTF material, normally:

- `materials/console/background01.vtf`
- `materials/console/background01_widescreen.vtf`

This repo includes source art at:

- `materialsrc/console/openvibe-loading.svg`

To fully replace the HL2 loading image, convert it to the two VTF filenames above using VTFEdit/VTFCmd or Valve's `vtex`, then place the VTFs in this folder.

Until those VTF files exist, `resource/LoadingDialog.res` can restyle text/layout, but the old HL2 image may still appear.
