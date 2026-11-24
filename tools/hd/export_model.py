"""Real-ESRGAN's anime model (RealESRGAN_x4plus_anime_6B.pth, BSD-3-Clause, Xintao Wang) as the
flat half-float file the game's HD upscaler reads (godot/scripts/hd/esrgan.gd).

    python tools/hd/export_model.py <RealESRGAN_x4plus_anime_6B.pth> godot/hd/anime6b.bin

Layout: "ESR1", the convolution count (uint32), then for each convolution in network order
(conv_first, body.B.rdbR.convK, conv_body, conv_up1, conv_up2, conv_hr, conv_last) its input and
output channel counts (uint32 each) followed by the weights [out][in][3x3] and the biases [out],
as float16, each convolution padded to a multiple of 2 values.
"""
import struct
import sys

import numpy as np
import torch

state = torch.load(sys.argv[1], map_location='cpu', weights_only=True)
state = state.get('params_ema', state.get('params', state))
blocks = 1 + max(int(k.split('.')[1]) for k in state if k.startswith('body.'))
names = ['conv_first']
for b in range(blocks):
    for r in range(1, 4):
        names += [f'body.{b}.rdb{r}.conv{k}' for k in range(1, 6)]
names += ['conv_body', 'conv_up1', 'conv_up2', 'conv_hr', 'conv_last']
with open(sys.argv[2], 'wb') as f:
    f.write(b'ESR1' + struct.pack('<I', len(names)))
    for n in names:
        w = state[n + '.weight'].numpy()
        bias = state[n + '.bias'].numpy()
        f.write(struct.pack('<II', w.shape[1], w.shape[0]))
        v = np.concatenate([w.reshape(-1), bias]).astype('<f2')
        if v.size % 2:
            v = np.append(v, np.float16(0))
        f.write(v.tobytes())
print(len(names), 'convolutions, blocks', blocks)
