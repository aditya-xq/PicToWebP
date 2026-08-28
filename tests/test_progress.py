"""Tests for the thread-safe ConversionProgress tracker."""

import threading

from pictowebp.progress import ConversionProgress


def test_initial_snapshot_is_idle_and_safe():
    progress = ConversionProgress()
    snap = progress.snapshot()

    assert snap["status"] == "idle"
    assert snap["total_files"] == 0
    assert snap["reduction_percent"] == 0.0
    assert snap["fraction_complete"] == 0.0
    assert progress.bytes_saved == 0


def test_record_and_finish_flow():
    progress = ConversionProgress()
    progress.start(total_files=3)
    progress.record(original_bytes=1000, converted_bytes=400)
    progress.record_failure()
    progress.record(original_bytes=1000, converted_bytes=500)
    progress.finish("completed", elapsed_seconds=1.5)

    snap = progress.snapshot()
    assert snap["status"] == "completed"
    assert snap["total_files"] == 3
    assert snap["processed_files"] == 3
    assert snap["converted_files"] == 2
    assert snap["failed_files"] == 1
    assert snap["bytes_saved"] == 1100
    assert snap["reduction_percent"] == 55.0
    assert snap["fraction_complete"] == 1.0
    assert snap["elapsed_seconds"] == 1.5


def test_finish_rejects_non_terminal_status():
    progress = ConversionProgress()
    try:
        progress.finish("running", elapsed_seconds=0.0)
    except ValueError:
        pass
    else:
        msg = "expected ValueError for non-terminal status"
        raise AssertionError(msg)


def test_concurrent_records_are_not_lost():
    progress = ConversionProgress()
    progress.start(total_files=800)

    def worker():
        for _ in range(100):
            progress.record(original_bytes=10, converted_bytes=5)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert progress.processed_files == 800
    snap = progress.snapshot()
    assert snap["original_bytes"] == 8000
    assert snap["converted_files"] == 800
