"""Aggiornamenti appena esce una release: avviso dal servizio account (updater.notify)
invece del controllo a intervalli."""
import threading
import time
import unittest
from unittest import mock

import updater

A = "a" * 40
B = "b" * 40


class AvvisoRelease(unittest.TestCase):
    def setUp(self):
        updater._push.update(at=0.0, commit="", version="")
        updater._wake.clear()
        self.cur = mock.patch.object(updater, "current_commit", return_value=A)
        self.cur.start()

    def tearDown(self):
        self.cur.stop()
        updater._push.update(at=0.0, commit="", version="")
        updater._wake.clear()

    def test_commit_gia_installato_non_sveglia(self):
        updater.notify(A, "3.42")
        self.assertTrue(updater.pushed())
        self.assertFalse(updater._wake.is_set())

    def test_commit_nuovo_sveglia_una_volta(self):
        updater.notify(B, "3.43")
        self.assertTrue(updater._wake.is_set())
        updater._wake.clear()
        updater.notify(B, "3.43")          # stesso annuncio alla presenza dopo: niente
        self.assertFalse(updater._wake.is_set())

    def test_valori_strani_ignorati(self):
        updater.notify("zz", "x")
        self.assertFalse(updater.pushed())
        self.assertFalse(updater._wake.is_set())

    def test_senza_avvisi_si_aspetta_il_tempo(self):
        t = time.time()
        updater._sleep(0.3)
        self.assertLess(time.time() - t, 3)

    def test_con_avvisi_niente_controllo_a_intervalli(self):
        updater.notify(A)
        done = threading.Event()
        th = threading.Thread(target=lambda: (updater._sleep(0.2), done.set()), daemon=True)
        th.start()
        self.assertFalse(done.wait(2.5))   # il tempo e' passato ma si aspetta l'avviso
        updater.notify(B)
        self.assertTrue(done.wait(3))
        self.assertFalse(updater._wake.is_set())

    def test_riprova_dopo_un_video_anche_con_avvisi(self):
        updater.notify(A)
        t = time.time()
        updater._sleep(0.3, always=True)
        self.assertLess(time.time() - t, 3)


if __name__ == "__main__":
    unittest.main()
