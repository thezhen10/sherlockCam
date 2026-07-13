# Character classifier model assets

Drop a Teachable Machine (or other TensorFlow.js) image-model export here:

- `model.json`
- `*.bin` weight shard file(s) (e.g. `group1-shard1of1.bin`)
- `metadata.json` (optional but useful - contains the ordered `labels` list)

Then update the `labels` array passed to `TensorflowCharacterDetector` in
`demo/main.ts` so it matches `metadata.json`'s `labels` exactly (same order).

Export steps (Teachable Machine):

1. Open https://teachablemachine.withgoogle.com/ and create an Image Project.
2. Add one class per character you want to detect; train with photos taken at
   the real distance/angle/lighting you expect in play.
3. Export Model -> TensorFlow.js -> Download my model.
4. Unzip the download into this folder (so `model.json` sits next to this README).
