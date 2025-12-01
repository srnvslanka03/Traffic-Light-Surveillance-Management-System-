import os
import sys
import threading
import uuid
import subprocess
import statistics
from typing import Dict, Any, List, Optional

from flask import Flask, jsonify, request, render_template
from ultralytics import YOLO

MODEL_PATH = "/mnt/data/yolov12s.pt"

model = None
if os.path.exists(MODEL_PATH):
    try:
        model = YOLO(MODEL_PATH)
        print("🟢 YOLO v12s model loaded from /mnt/data")
    except Exception as e:
        print("🔴 Error loading YOLO v12s model:", e)
else:
    print("⚠️ YOLO v12s model not found. Detection disabled.")


from data_pipeline.loader import (
    CityRecord,
    build_index,
    load_city_records,
    normalize_key,
)


app = Flask(__name__)


class SimulationRun:
    def __init__(self, run_id: str, params: Dict[str, Any]):
        self.run_id = run_id
        self.params = params
        self.log_lines: List[str] = []
        self.status: str = "running"  # "running" | "finished" | "error"
        self.stats: Dict[str, Any] = {
            "phase": "",
            "lanes": {1: 0, 2: 0, 3: 0, 4: 0},
            "lane_details": {
                1: {"total": 0, "car": 0, "bus": 0, "truck": 0, "rickshaw": 0, "bike": 0},
                2: {"total": 0, "car": 0, "bus": 0, "truck": 0, "rickshaw": 0, "bike": 0},
                3: {"total": 0, "car": 0, "bus": 0, "truck": 0, "rickshaw": 0, "bike": 0},
                4: {"total": 0, "car": 0, "bus": 0, "truck": 0, "rickshaw": 0, "bike": 0},
            },
            "total_vehicles": 0,
            "total_time": 0,
            "throughput": 0.0,
            "traffic_density": 0,
            "average_wait": 0,
            "congestion_level": 0,
        }
        self.process: Optional[subprocess.Popen] = None


runs: Dict[str, SimulationRun] = {}
runs_lock = threading.Lock()

city_records: List[CityRecord] = load_city_records()
city_index: Dict[str, CityRecord] = build_index(city_records)


def _score_city(record: CityRecord) -> Dict[str, Any]:
    # Composite score favouring high delays, low peak speed and large population influence.
    delay_score = min(1.0, record.avg_delay_minutes / 45.0)
    speed_score = 1.0 - min(1.0, record.avg_peak_speed_kmph / 40.0)
    population_score = min(1.0, record.population_millions / 15.0)
    composite = round((delay_score * 0.45 + speed_score * 0.35 + population_score * 0.2) * 100, 1)

    priority_band = "Moderate"
    if composite >= 70:
        priority_band = "High"
    elif composite >= 45:
        priority_band = "Medium"

    return {
        "score": composite,
        "priority": priority_band,
        "rationale": [
            f"Average delay of {record.avg_delay_minutes:.0f} minutes",
            f"Peak speed around {record.avg_peak_speed_kmph:.0f} km/h",
            f"Population ~{record.population_millions:.1f}M",
        ],
    }


def _aggregate_home_metrics(records: List[CityRecord]) -> Dict[str, Any]:
    total = len(records)
    if not records:
        return {
            "density": 0,
            "avg_wait": 0,
            "travel_speed": 0,
            "city_count": 0,
            "priority_high_pct": 0,
            "priority_medium_pct": 0,
        }

    delays = [record.avg_delay_minutes for record in records]
    speeds = [record.avg_peak_speed_kmph for record in records]
    density = round(min(95.0, max(15.0, statistics.mean(delays) / 45.0 * 100.0)))
    avg_wait = round(statistics.mean(delays))
    travel_speed = round(statistics.mean(speeds), 1)

    priority_counts = {"High": 0, "Medium": 0, "Moderate": 0}
    for record in records:
        priority_counts[_score_city(record)["priority"]] += 1

    def pct(value: int) -> int:
        return round(value / total * 100) if total else 0

    return {
        "density": density,
        "avg_wait": avg_wait,
        "travel_speed": travel_speed,
        "city_count": total,
        "priority_high_pct": pct(priority_counts["High"]),
        "priority_medium_pct": pct(priority_counts["Medium"]),
        "priority_moderate_pct": pct(priority_counts["Moderate"]),
    }


home_metrics: Dict[str, Any] = _aggregate_home_metrics(city_records)


def _record_to_payload(record: CityRecord) -> Dict[str, Any]:
    suitability = _score_city(record)
    return {
        "city": record.city,
        "state": record.state,
        "classification": record.classification,
        "population_millions": record.population_millions,
        "avg_peak_speed_kmph": record.avg_peak_speed_kmph,
        "avg_delay_minutes": record.avg_delay_minutes,
        "vehicle_mix": record.vehicle_mix,
        "issues": record.issues,
        "recommended_actions": record.recommended_actions,
        "suitability": suitability,
    }


def _search_records(query: Optional[str]) -> List[CityRecord]:
    if not query:
        return sorted(city_records, key=lambda r: (-r.avg_delay_minutes, r.city))

    needle = query.strip().lower()
    matches: List[CityRecord] = []
    for record in city_records:
        haystack = f"{record.city.lower()} {record.state.lower()} {record.classification.lower()}"
        if needle in haystack:
            matches.append(record)
    return matches[:50]


def _parse_stats_from_line(run: SimulationRun, line: str) -> None:
    line = line.strip()
    if not line:
        return

    # Current phase from signal status lines
    if "GREEN TS" in line or "YELLOW TS" in line or "RED TS" in line:
        run.stats["phase"] = line

    if line.startswith("LANE_STATS"):
        try:
            parts = line.split()[1:]
            data = {}
            for part in parts:
                key, value = part.split("=")
                data[key] = value
            lane_idx = int(data.get("lane", "0"))
            if lane_idx:
                total = int(data.get("total", "0"))
                lane_details = {
                    "total": total,
                    "car": int(data.get("car", "0")),
                    "bus": int(data.get("bus", "0")),
                    "truck": int(data.get("truck", "0")),
                    "rickshaw": int(data.get("rickshaw", "0")),
                    "bike": int(data.get("bike", "0")),
                }
                run.stats["lanes"][lane_idx] = total
                run.stats["lane_details"][lane_idx] = lane_details
        except Exception:
            pass

    # Lane totals
    if line.startswith("Lane ") and "Total:" in line:
        # Example: 'Lane 1: Total: 38'
        try:
            parts = line.split(":")
            lane_part = parts[0].strip()  # "Lane 1"
            total_part = parts[2].strip() if len(parts) > 2 else ""
            lane_num = int(lane_part.split()[1])
            total_val = int(total_part)
            run.stats["lanes"][lane_num] = total_val
        except Exception:
            pass

    # Total vehicles
    if line.startswith("Total vehicles passed"):
        try:
            val_str = line.split(":")[1].strip()
            run.stats["total_vehicles"] = int(float(val_str))
        except Exception:
            pass

    # Total time
    if line.startswith("Total time passed"):
        try:
            val_str = line.split(":")[1].strip()
            run.stats["total_time"] = int(float(val_str))
        except Exception:
            pass
        _update_summary_metrics(run)

    # Throughput
    if line.startswith("No. of vehicles passed per unit time"):
        try:
            val_str = line.split(":")[1].strip()
            run.stats["throughput"] = float(val_str)
        except Exception:
            pass
        _update_summary_metrics(run)

    if line.startswith("SUMMARY"):
        try:
            parts = line.split()[1:]
            data = {}
            for part in parts:
                key, value = part.split("=")
                data[key] = value
            if "total" in data:
                run.stats["total_vehicles"] = int(float(data["total"]))
            if "time" in data:
                run.stats["total_time"] = int(float(data["time"]))
            if "throughput" in data:
                run.stats["throughput"] = float(data["throughput"])
        except Exception:
            pass
        _update_summary_metrics(run)

    if line.startswith("SIMULATION_COMPLETE"):
        run.status = "finished"


def _update_summary_metrics(run: SimulationRun) -> None:
    total_time = run.stats.get("total_time", 0)
    total_vehicles = run.stats.get("total_vehicles", 0)
    if total_vehicles > 0:
        avg_wait = max(0, total_time / total_vehicles)
    else:
        avg_wait = 0
    run.stats["average_wait"] = round(avg_wait, 2)

    sim_time = run.params.get("sim_time", 120) or 1
    theoretical_capacity = sim_time * 4
    if theoretical_capacity <= 0:
        theoretical_capacity = 1
    density_ratio = min(1.0, total_vehicles / theoretical_capacity)
    run.stats["traffic_density"] = round(density_ratio * 100, 1)
    run.stats["congestion_level"] = run.stats["traffic_density"]


def _run_simulation_subprocess(run: SimulationRun) -> None:
    """Background thread target: run simulation.py and capture output."""
    try:
        project_root = os.path.dirname(os.path.abspath(__file__))

        env = os.environ.copy()
        env["SIM_TIME"] = str(run.params.get("sim_time", 120))
        env["MIN_GREEN_TIME"] = str(run.params.get("min_green", 10))
        env["MAX_GREEN_TIME"] = str(run.params.get("max_green", 60))
        env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
        if not env.get("DISPLAY") and os.name != "nt":
            env.setdefault("SDL_VIDEODRIVER", "dummy")
            env.setdefault("SDL_AUDIODRIVER", "dummy")

        python_executable = sys.executable or "python"

        run.process = subprocess.Popen(
            [python_executable, "simulation.py"],
            cwd=project_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        assert run.process.stdout is not None

        for line in run.process.stdout:
            with runs_lock:
                run.log_lines.append(line.rstrip("\n"))
                _parse_stats_from_line(run, line)

        run.process.wait()
        with runs_lock:
            if run.status == "stopped":
                run.log_lines.append("[system] simulation halted by user")
            else:
                if run.process.returncode == 0:
                    run.status = "finished"
                else:
                    run.status = "error"
            run.process = None
    except Exception as exc:  # pragma: no cover - debug aid
        with runs_lock:
            run.log_lines.append(f"[backend error] {exc}")
            run.status = "error"


@app.route("/")
def home():
    return render_template("home.html", home_metrics=home_metrics)


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


@app.route("/awareness")
def awareness():
    return render_template("awareness.html")


@app.route("/cities")
def cities():
    return render_template("cities.html")


@app.route("/api/cities", methods=["GET"])
def api_cities():
    query = request.args.get("q", "").strip()
    records = _search_records(query)
    payload = [_record_to_payload(record) for record in records]
    return jsonify({"count": len(payload), "items": payload})


@app.route("/api/cities/<slug>", methods=["GET"])
def api_city_detail(slug: str):
    key = normalize_key(slug)
    record = city_index.get(key)
    if not record:
        # allow matching on raw city names if slug not found
        record = city_index.get(normalize_key(slug.replace("-", " ")))
    if not record:
        return jsonify({"error": "city not found"}), 404
    return jsonify(_record_to_payload(record))


@app.route("/api/run", methods=["POST"])
def api_run():
    payload = request.get_json(force=True, silent=True) or {}
    sim_time = int(payload.get("sim_time", 120))
    min_green = int(payload.get("min_green", 10))
    max_green = int(payload.get("max_green", 60))

    run_id = str(uuid.uuid4())
    run = SimulationRun(
        run_id,
        {"sim_time": sim_time, "min_green": min_green, "max_green": max_green},
    )

    with runs_lock:
        runs[run_id] = run

    thread = threading.Thread(target=_run_simulation_subprocess, args=(run,))
    thread.daemon = True
    thread.start()

    return jsonify({"run_id": run_id, "status": run.status})


@app.route("/api/status/<run_id>", methods=["GET"])
def api_status(run_id: str):
    with runs_lock:
        run = runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found"}), 404

        # Return last 300 log lines to avoid huge payloads
        log_tail = run.log_lines[-300:]

        return jsonify(
            {
                "run_id": run.run_id,
                "status": run.status,
                "params": run.params,
                "log": log_tail,
                "stats": run.stats,
            }
        )


@app.route("/api/stop/<run_id>", methods=["POST"])
def api_stop(run_id: str):
    with runs_lock:
        run = runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found"}), 404

        proc = run.process
        if proc and proc.poll() is None:
            run.log_lines.append("[system] stop requested by user")
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        run.status = "stopped"
        run.process = None

    return jsonify({"run_id": run_id, "status": "stopped"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=5000, debug=True)


