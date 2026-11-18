#!/usr/bin/env python3
"""Standalone tests for Deterministic Q1.14 Fixed-Point Sparse State-Channel Bussing."""
import hashlib
import math
import os
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "python"))

from sparse_state_bus import (
    LEGACY_FRAME_BYTES,
    Q14_SCALE,
    SIN_LUT_Q14,
    SparseStateChannelBus,
    apply_sparse_bus_potato_move,
)


class _PotatoChannelStub:
    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id
        self.state_number = 0
        self.last_hash = None

    def send_potato_move(self, game_id: str, move_details: dict, mover_share: int):
        self.state_number += 1
        move_hash = hashlib.sha256(str(move_details).encode()).hexdigest()
        potato = {
            "channel_id": self.channel_id,
            "game_id": game_id,
            "state_number": self.state_number,
            "move_hash": move_hash,
            "mover_share": mover_share,
        }
        sig = hashlib.sha256(str(potato).encode()).hexdigest()
        self.last_hash = move_hash
        return potato, sig


class TestSparseStateChannelBus(unittest.TestCase):
    def test_static_descriptor_layout_and_q14_lut_precision(self):
        bus = SparseStateChannelBus()
        self.assertEqual(bus.node_count, 18000)
        self.assertEqual(len(bus.packed_u16), 144000)
        self.assertEqual(len(bus.static_descriptor_root), 32)

        err_sq = 0.0
        sig_sq = 0.0
        for i in range(256):
            exact = math.sin((i / 256.0) * math.pi * 2.0)
            q = SIN_LUT_Q14[i] / float(Q14_SCALE)
            err_sq += (exact - q) ** 2
            sig_sq += exact ** 2
        self.assertGreater(10.0 * math.log10(sig_sq / err_sq), 90.0)

    def test_zero_drift_determinism_and_24000x_compression(self):
        mover = SparseStateChannelBus(seed=0x4B0BA42)
        waiter = SparseStateChannelBus(seed=0x4B0BA42)
        self.assertEqual(mover.static_descriptor_root, waiter.static_descriptor_root)

        last_m = None
        for step in range(200):
            az_q14 = (step * 512) % 102944
            last_m = mover.step_fixed_point(az_q14, 22118)
            last_w = waiter.step_fixed_point(az_q14, 22118)
            self.assertEqual(len(last_m.payload_48b), 48)
            self.assertEqual(last_m.payload_48b, last_w.payload_48b)
            self.assertEqual(last_m.commitment_32b, last_w.commitment_32b)

        self.assertEqual(LEGACY_FRAME_BYTES // len(last_m.payload_48b), 24000)

    def test_potato_channel_payload_adapter(self):
        bus = SparseStateChannelBus(seed=0x51A71800)
        tick = bus.step_fixed_point(azimuth_q14=12868, wind_speed_q14=22118)
        stub = _PotatoChannelStub("chan_k42_01")
        potato, sig = apply_sparse_bus_potato_move(stub, "chia_sparse_01", tick, mover_share=1050)
        self.assertEqual(potato["mover_share"], 1050)
        self.assertEqual(len(sig), 64)


if __name__ == "__main__":
    unittest.main()
