"""Shared Python engine: native CPython or Pyodide, with no UI dependencies."""
import base64
import io
import itertools
import json
import math
import random

import networkx as nx
import numpy as np

MODELS = {"erdos": "Erdős–Rényi", "geometric": "Random geometric",
          "regular": "Random regular", "planar": "Random planar"}
LAYOUTS = {"spring", "circular", "shell", "spiral", "random", "spectral", "planar", "geometric"}
PALETTES = {"RdBu_r", "coolwarm", "PuOr", "viridis"}


def number(value, name, low, high, integer=False):
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise ValueError(f"{name} must be a number.") from None
    if not math.isfinite(result) or not low <= result <= high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    if integer and result != int(result):
        raise ValueError(f"{name} must be an integer.")
    return int(result) if integer else result


def config_from(raw):
    model = raw.get("model", "erdos")
    if model not in MODELS:
        raise ValueError("Choose a supported graph model.")
    guess_feedback = raw.get("guess_feedback", False)
    if not isinstance(guess_feedback, bool):
        raise ValueError("Guess closeness must be on or off.")
    n = number(raw.get("n", 12), "N", 1, 50, True)
    c = {"model": model, "n": n,
         "seed": number(raw.get("seed", 42), "Seed", 0, 4294967295, True),
         "epsilon": number(raw.get("epsilon", .15), "Tolerance", 0.000001, 2),
         "guess_cost": number(raw.get("guess_cost", 10), "Guess penalty", 1, 100, True),
         "hint_cost": number(raw.get("hint_cost", 50), "Hint penalty", 0, 500, True),
         "guess_feedback": guess_feedback}
    if model == "erdos":
        c["p"] = number(raw.get("p", .25), "Edge probability", 0, 1)
    elif model == "geometric":
        c["radius"] = number(raw.get("radius", .35), "Radius", 0, 6)
        c["dimension"] = number(raw.get("dimension", 2), "Dimension", 1, 6, True)
        c["metric"] = str(raw.get("metric", "2"))
        if c["metric"] not in {"1", "2", "inf"}:
            raise ValueError("Choose Manhattan, Euclidean, or maximum distance.")
    elif model == "regular":
        c["degree"] = number(raw.get("degree", 3), "Degree", 0, n - 1, True)
        if n * c["degree"] % 2:
            raise ValueError("A regular graph requires N × degree to be even.")
    else:
        c["connected"] = bool(raw.get("connected", True))
        maximum = min(n * (n - 1) // 2, max(0, 3 * n - 6)) if n >= 3 else n - 1
        minimum = n - 1 if c["connected"] else 0
        c["edges"] = number(raw.get("edges", min(maximum, 2 * n)), "Planar edge count", minimum, maximum, True)
    return c


def generate_graph(c):
    n, seed, model = c["n"], c["seed"], c["model"]
    rng = random.Random(seed)
    if model == "erdos":
        graph = nx.gnp_random_graph(n, c["p"], seed=seed)
    elif model == "geometric":
        # Explicit O(N²) distances avoid a SciPy download in the browser.
        positions = {i: [rng.random() for _ in range(c["dimension"])] for i in range(n)}
        graph = nx.empty_graph(n)
        nx.set_node_attributes(graph, positions, "pos")
        for i, j in itertools.combinations(range(n), 2):
            delta = [abs(a-b) for a, b in zip(positions[i], positions[j])]
            distance = (max(delta) if c["metric"] == "inf" else
                        sum(delta) if c["metric"] == "1" else math.sqrt(sum(x*x for x in delta)))
            if distance <= c["radius"]:
                graph.add_edge(i, j)
    elif model == "regular":
        graph = nx.random_regular_graph(c["degree"], n, seed=seed)
    else:
        # This is a specified nonuniform planar model, not a uniform sampler.
        graph = nx.empty_graph(n)
        if c["connected"] and n >= 2:
            tree = nx.from_prufer_sequence([rng.randrange(n) for _ in range(n - 2)])
            graph.add_edges_from(tree.edges())
        candidates = list(nx.non_edges(graph))
        rng.shuffle(candidates)
        for i, j in candidates:
            if graph.number_of_edges() >= c["edges"]:
                break
            graph.add_edge(i, j)
            if not nx.check_planarity(graph)[0]:
                graph.remove_edge(i, j)
        if graph.number_of_edges() != c["edges"]:
            raise ValueError("Could not reach this planar edge count. Try another seed.")
    return graph


def positions_for(graph, layout, seed):
    if layout not in LAYOUTS:
        raise ValueError("Choose a supported layout.")
    if layout == "geometric":
        p = nx.get_node_attributes(graph, "pos")
        if len(p) != len(graph):
            raise ValueError("Geometric coordinates are available for geometric graphs only.")
        pos = {i: (v[0], v[1] if len(v) > 1 else 0) for i, v in p.items()}
    elif layout == "planar":
        if not nx.check_planarity(graph)[0]:
            raise ValueError("This graph is not planar. Choose another layout.")
        pos = nx.planar_layout(graph)
    elif layout == "spring":
        pos = nx.spring_layout(graph, seed=seed, iterations=100)
    elif layout == "random":
        pos = nx.random_layout(graph, seed=seed)
    else:
        pos = getattr(nx, layout + "_layout")(graph)
    coords = np.array([pos[i] for i in range(len(graph))], dtype=float)
    coords -= (coords.max(axis=0) + coords.min(axis=0)) / 2
    span = float(np.max(np.ptp(coords, axis=0)))
    if span > 1e-12:
        coords *= 2 / span
    return coords.tolist()


class Game:
    def __init__(self, config, layout="spring"):
        self.config = config_from(config)
        self.graph = generate_graph(self.config)
        self.layout = layout
        self.positions = positions_for(self.graph, layout, self.config["seed"])
        self.adjacency = nx.to_numpy_array(self.graph, nodelist=range(self.config["n"]), weight=None)
        self.values, self.vectors = np.linalg.eigh(self.adjacency)
        # Fix a sign for repeatable display; repeated eigenspaces still have no unique basis.
        for i in range(len(self.values)):
            col = self.vectors[:, i]
            if col[np.argmax(np.abs(col))] < 0:
                self.vectors[:, i] *= -1
        self.found = []
        self.attempts = 0
        self.hints = 0
        self.status = "playing"
        self.history = []
        self.last_guess_quality = None
        self.feedback_used = False
        self.active = None
        self.hint_ids = set()
        self.rng = random.Random(self.config["seed"] ^ 0xA13D)

    @property
    def score(self):
        if self.status == "given_up":
            return 0
        return max(0, 1000 - self.attempts * self.config["guess_cost"] - self.hints * self.config["hint_cost"])

    def guess(self, value):
        if self.status != "playing":
            raise ValueError("Start a new round to keep playing.")
        value = number(value, "Guess", -1e12, 1e12)
        self.attempts += 1
        remaining = [i for i in range(len(self.values)) if i not in self.found]
        index = min(remaining, key=lambda i: abs(self.values[i] - value))
        error = abs(float(self.values[index]) - value)
        # A few ulps protect inclusive interval boundaries, without broadening epsilon.
        slack = 8 * np.finfo(float).eps * max(1, abs(value), abs(float(self.values[index])))
        matched = bool(error <= self.config["epsilon"] + slack)
        # Freeze feedback against the remaining spectrum BEFORE consuming a match.
        distance_in_tolerances = error / self.config["epsilon"]
        position = 0.0 if matched else min(1.0, max(0.0, (distance_in_tolerances - 1) / 9))
        label = ("Within tolerance" if matched else "Very close" if distance_in_tolerances <= 2
                 else "Close" if distance_in_tolerances <= 4 else "Somewhat close"
                 if distance_in_tolerances <= 7 else "Far away")
        self.last_guess_quality = {"guess": value, "position": float(position), "label": label}
        if self.config["guess_feedback"]:
            self.feedback_used = True
        entry = {"guess": value, "matched": matched}
        if matched:
            self.found.append(index)
            entry["value"] = float(self.values[index])
            if len(self.found) == len(self.values):
                self.status = "solved"
        self.history.append(entry)
        # Keep rendering bounded, while attempts and penalties remain unlimited.
        self.history = self.history[-100:]
        return entry

    def set_guess_feedback(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError("Guess closeness must be on or off.")
        self.config["guess_feedback"] = enabled
        # Turning feedback off later must not erase assistance already received.
        if enabled and self.history and self.status == "playing":
            self.feedback_used = True

    def hint(self):
        if self.status != "playing":
            raise ValueError("Hints are available during a round.")
        remaining = [i for i in range(len(self.values)) if i not in self.found]
        fresh = [i for i in remaining if i not in self.hint_ids]
        self.active = self.rng.choice(fresh or remaining)
        self.hint_ids.add(self.active)
        self.hints += 1

    def select(self, index):
        if index is None:
            self.active = None
            return
        index = number(index, "Eigenvector", 0, len(self.values) - 1, True)
        if self.status == "playing" and index not in self.found and index not in self.hint_ids:
            raise ValueError("Guess this eigenvalue or use a hint to view its eigenvector.")
        self.active = index

    def change_layout(self, layout):
        positions = positions_for(self.graph, layout, self.config["seed"])
        self.positions, self.layout = positions, layout

    def state(self):
        revealed = self.status != "playing"
        visible = self.found + ([i for i in range(len(self.values)) if i not in self.found] if revealed else [])
        active = None
        if self.active is not None:
            active = {"id": self.active, "vector": self.vectors[:, self.active].tolist(),
                      "value": float(self.values[self.active]) if revealed or self.active in self.found else None}
        return {"config": self.config, "model_name": MODELS[self.config["model"]],
                "edges": [list(edge) for edge in self.graph.edges()], "positions": self.positions,
                "layout": self.layout, "status": self.status, "score": self.score,
                "attempts": self.attempts, "hints": self.hints, "found_count": len(self.found),
                "modes": [{"id": i, "value": float(self.values[i]), "found": i in self.found} for i in visible],
                "active": active, "history": self.history,
                "guess_quality": self.last_guess_quality if self.config["guess_feedback"] else None,
                "feedback_used": self.feedback_used,
                "hint_ids": sorted(self.hint_ids - set(self.found)) if not revealed else []}

    def plot(self, palette="RdBu_r", labels=True, node_size=420):
        if palette not in PALETTES:
            raise ValueError("Unknown heatmap palette.")
        node_size = number(node_size, "Node size", 50, 1600)
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib.figure import Figure
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        fig = Figure(figsize=(9, 6), facecolor="#f7f9fc")
        FigureCanvasAgg(fig)
        ax = fig.subplots()
        ax.set_facecolor("#f7f9fc")
        pos = dict(enumerate(self.positions))
        options = {"node_color": "#4263eb"}
        if self.active is not None:
            values = self.vectors[:, self.active]
            bound = max(float(np.max(np.abs(values))), 1e-12)
            options = {"node_color": values, "cmap": matplotlib.colormaps[palette], "vmin": -bound, "vmax": bound}
        nx.draw_networkx_edges(self.graph, pos, ax=ax, edge_color="#b4bfd1", width=1.1)
        nodes = nx.draw_networkx_nodes(self.graph, pos, nodelist=range(len(self.graph)), ax=ax,
                                      node_size=node_size, edgecolors="#24365b", linewidths=.7, **options)
        if labels:
            nx.draw_networkx_labels(self.graph, pos, ax=ax, font_color="#101c35", font_size=9,
                                    bbox={"facecolor":"white", "edgecolor":"none", "alpha":.75, "pad":.4})
        if self.active is not None:
            fig.colorbar(nodes, ax=ax, shrink=.7, label="Eigenvector component (unit L2 norm)")
        ax.set_axis_off()
        ax.margins(.12)
        out = io.BytesIO()
        fig.savefig(out, format="png", dpi=140, bbox_inches="tight")
        fig.clear()
        return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


class Engine:
    def __init__(self):
        self.game = None

    def dispatch(self, request):
        action = request.get("action")
        if action == "new":
            # Construction is transactional: bad settings preserve the existing round.
            game = Game(request.get("config", {}), request.get("layout", "spring"))
            self.game = game
        else:
            if self.game is None:
                raise ValueError("Start a round first.")
            if action == "guess":
                self.game.guess(request.get("value"))
            elif action == "feedback":
                self.game.set_guess_feedback(request.get("enabled"))
            elif action == "hint":
                self.game.hint()
            elif action == "select":
                self.game.select(request.get("id"))
            elif action == "layout":
                self.game.change_layout(request.get("layout"))
            elif action == "give_up":
                if self.game.status == "playing":
                    self.game.status = "given_up"
            elif action == "plot":
                return {"image": self.game.plot(request.get("palette", "RdBu_r"), request.get("labels", True), request.get("node_size", 420))}
            elif action != "state":
                raise ValueError("Unknown action.")
        return self.game.state()

    def json(self, request_json):
        try:
            return json.dumps({"ok": True, "data": self.dispatch(json.loads(request_json))}, allow_nan=False)
        except (ValueError, TypeError, nx.NetworkXException) as error:
            return json.dumps({"ok": False, "error": str(error)})
