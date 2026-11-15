#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LUNAR MISSION PLANNER v3.1 — Artemis IV (учебная реализация панели управления)

Установка:
    pip install PyQt5 pyqtgraph matplotlib numpy astropy

Запуск:
    python lunar_mission_planner.py

Библиотеки:
    PyQt5      — окно и панели
    PyQtGraph  — телеметрия (сигнал/шум, задержка) в реальном времени
    Matplotlib — топография кратера, орбиты, маршрут до Луны
    Astropy    — положения Солнца и Луны, угол к Солнцу, расстояние до Луны
                 (встроенные эфемериды, интернет не нужен)
"""
import sys
import numpy as np

from PyQt5 import QtCore, QtWidgets
import pyqtgraph as pg

import matplotlib
matplotlib.use("QtAgg")
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from matplotlib.patches import Circle, Ellipse

from astropy.time import Time
from astropy.coordinates import get_body, solar_system_ephemeris
import astropy.units as u

# ----------------------------------------------------------------- стили
BG = "#060b1d"
PANEL_BG = "#0a1230"
RED = "#b3131b"
TEXT = "#e8ecf8"
GREEN = "#19e04a"

STYLE = f"""
QWidget {{ background:{BG}; color:{TEXT}; font-family:'Segoe UI','DejaVu Sans'; font-size:12px; }}
QFrame#panel {{ background:{PANEL_BG}; border:1px solid #3a4a7a; border-radius:6px; }}
QLabel#title {{ background:{RED}; color:white; font-size:16px; font-weight:bold; padding:4px 10px;
               border-top-left-radius:5px; border-top-right-radius:5px; }}
QLabel {{ background:transparent; }}
QPushButton {{ background:{PANEL_BG}; color:{TEXT}; border:1px solid #5a6aa0; border-radius:4px;
              padding:6px 8px; font-weight:bold; }}
QPushButton:hover {{ background:#1a2750; }}
QPushButton:checked {{ background:#dfe6f7; color:#0a1230; }}
"""


def make_panel(title, extra_widget=None):
    """Панель с красным заголовком. Возвращает (frame, body_layout)."""
    frame = QtWidgets.QFrame()
    frame.setObjectName("panel")
    v = QtWidgets.QVBoxLayout(frame)
    v.setContentsMargins(0, 0, 0, 6)
    v.setSpacing(4)
    head = QtWidgets.QLabel(title)
    head.setObjectName("title")
    if extra_widget is not None:
        row = QtWidgets.QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(head, 1)
        row.addWidget(extra_widget)
        v.addLayout(row)
    else:
        v.addWidget(head)
    body = QtWidgets.QVBoxLayout()
    body.setContentsMargins(10, 0, 10, 0)
    v.addLayout(body)
    return frame, body


def mpl_canvas(w=4, h=3):
    fig = Figure(figsize=(w, h), facecolor=PANEL_BG)
    canvas = FigureCanvas(fig)
    canvas.setStyleSheet(f"background:{PANEL_BG};")
    return fig, canvas


# ----------------------------------------------------------------- расчёты
class AstroCalc:
    """Астрономические расчёты на Astropy."""

    def __init__(self):
        solar_system_ephemeris.set("builtin")

    def snapshot(self):
        t = Time.now()
        sun = get_body("sun", t)
        moon = get_body("moon", t)
        elong = float(sun.separation(moon).deg)       # угол Солнце–Земля–Луна
        moon_km = float(moon.distance.to(u.km).value)
        return {"time": t, "elongation": elong, "moon_km": moon_km}


def crater_dem(n=200, size_km=40.0, diameter_km=21.0, depth_km=4.2, seed=7):
    """
    Синтетическая модель рельефа кратера Шеклтон (R≈10.5 км, глубина ≈4.2 км).
    Для реальных данных подставьте LOLA DEM (NASA PDS) вместо этой функции.
    """
    rng = np.random.default_rng(seed)
    x = np.linspace(-size_km / 2, size_km / 2, n)
    X, Y = np.meshgrid(x, x)
    r = np.hypot(X, Y)
    R = diameter_km / 2
    z = np.where(r < R, -depth_km * (1 - (r / R) ** 2.2), 0.0)
    rim = 0.5 * np.exp(-((r - R) / 1.2) ** 2)            # вал кратера
    noise = rng.normal(0, 1, (n, n))
    k = np.exp(-(np.linspace(-3, 3, 9) ** 2) / 2)
    k /= k.sum()
    noise = np.apply_along_axis(lambda m: np.convolve(m, k, "same"), 0, noise)
    noise = np.apply_along_axis(lambda m: np.convolve(m, k, "same"), 1, noise)
    return X, Y, z + rim + 0.25 * noise


# ----------------------------------------------------------------- главное окно
class Dashboard(QtWidgets.QWidget):
    TOTAL_HOURS = 114.26      # время полёта по плану (ч)

    def __init__(self):
        super().__init__()
        self.setWindowTitle("LUNAR MISSION PLANNER v3.1")
        self.resize(1680, 940)
        self.setStyleSheet(STYLE)

        self.astro = AstroCalc()
        self.t0 = QtCore.QDateTime.currentDateTime()
        self.progress = 0.35                     # доля пройденного маршрута
        self.route_mode = "route"
        self.N = 300
        self.snr = np.full(self.N, 60.0)
        self.delay = np.full(self.N, 20.0)
        self.rng = np.random.default_rng(1)

        root = QtWidgets.QVBoxLayout(self)
        root.addLayout(self._header())

        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        left = QtWidgets.QVBoxLayout()
        left.addWidget(self._goal_panel())
        mid = QtWidgets.QHBoxLayout()
        col = QtWidgets.QVBoxLayout()
        col.addWidget(self._site_panel())
        col.addWidget(self._comm_panel(), 1)
        mid.addLayout(col, 1)
        mid.addWidget(self._solar_panel(), 2)
        left.addLayout(mid, 1)
        main.addLayout(left, 2)

        right = QtWidgets.QVBoxLayout()
        right.addWidget(self._topo_panel(), 1)
        right.addWidget(self._route_panel(), 1)
        main.addLayout(right, 1)

        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(1000)
        self.tick()
        self.refresh_astro()

    # ---------------------------------------------------------- шапка
    def _header(self):
        lay = QtWidgets.QVBoxLayout()
        row = QtWidgets.QHBoxLayout()
        title = QtWidgets.QLabel("<b>LUNAR MISSION PLANNER</b> v3.1 &nbsp;|&nbsp; "
                                 "MISSION: ARTEMIS IV - LUNAR LANDING PREPARATION")
        title.setStyleSheet("font-size:18px;")
        self.clock = QtWidgets.QLabel("00:00:00")
        self.clock.setStyleSheet("font-size:34px; font-weight:300;")
        row.addWidget(title, 1)
        row.addWidget(self.clock)
        lay.addLayout(row)
        st = QtWidgets.QLabel(
            "СТАТУС МОДУЛЯ: <span style='color:#e0202a'>■■</span>□ &nbsp;&nbsp;&nbsp; "
            "СТАТУС СВЯЗИ: <span style='color:#e0202a'>■■</span>□ &nbsp;&nbsp;&nbsp; "
            "СТАТУС НАВИГАЦИИ: <span style='color:#e0202a'>■■</span>□")
        st.setStyleSheet("font-size:11px;")
        lay.addWidget(st)
        return lay

    # ---------------------------------------------------------- цель миссии
    def _goal_panel(self):
        led = QtWidgets.QLabel("● ЛУНА-1")
        led.setStyleSheet(f"color:{GREEN}; font-weight:bold; background:{RED}; padding-right:10px;")
        f, b = make_panel("ЦЕЛЬ МИССИИ", led)
        t = QtWidgets.QLabel("ПОСАДКА НА ЮЖНЫЙ ПОЛЮС ЛУНЫ, РАЗВЁРТЫВАНИЕ БАЗЫ, "
                             "НАУЧНЫЕ ИССЛЕДОВАНИЯ (КРАТЕР ШЕКЛТОН)")
        t.setStyleSheet("font-size:15px; font-weight:bold;")
        s = QtWidgets.QLabel("Многослойная научная операция с орбитальным комплексом")
        s.setStyleSheet("font-size:10px; color:#9aa6c8;")
        b.addWidget(t)
        b.addWidget(s)
        return f

    def _site_panel(self):
        f, b = make_panel("ПОСАДОЧНАЯ ЗОНА")
        b.addWidget(QtWidgets.QLabel(
            "● Южный полюс Луны<br>Лазерные маяки, база<br>"
            "Кратер Шеклтон<br>Сектор B4"))
        return f

    # ---------------------------------------------------------- анализ связи (PyQtGraph)
    def _comm_panel(self):
        f, b = make_panel("АНАЛИЗ СВЯЗИ")
        self.tel_label = QtWidgets.QLabel()
        self.tel_label.setTextFormat(QtCore.Qt.RichText)
        b.addWidget(self.tel_label)

        pg.setConfigOptions(antialias=True, background=PANEL_BG, foreground=TEXT)
        self.plot = pg.PlotWidget()
        self.plot.showGrid(x=True, y=True, alpha=0.25)
        self.plot.setLabel("left", "СИГНАЛ / ШУМ, дБ")
        self.plot.setLabel("right", "ЗАДЕРЖКА, мс")
        self.plot.setYRange(0, 100)
        self.curve_snr = self.plot.plot(pen=pg.mkPen("#e0202a", width=2),
                                        fillLevel=0, brush=(224, 32, 42, 70))
        self.curve_delay = self.plot.plot(pen=pg.mkPen("w", width=2))
        b.addWidget(self.plot, 1)

        b.addWidget(QtWidgets.QLabel(
            "Дополнительные станции:<br>DSN-48, Канберра<br>Мощность: 12 дБт"))
        return f

    # ---------------------------------------------------------- солнце и земля (Matplotlib + Astropy)
    def _solar_panel(self):
        f, b = make_panel("SOLAR & EARTH POSITIONING")
        self.solar_info = QtWidgets.QLabel()
        b.addWidget(self.solar_info)
        self.fig_solar, cv = mpl_canvas(6, 5)
        self.ax_solar = self.fig_solar.add_subplot(111)
        b.addWidget(cv, 1)
        self.comm_info = QtWidgets.QLabel(
            "<b>СВ936</b> (Comm)<br>УГОЛ СВЯЗИ: 15° | ДОСТУПНОСТЬ: <b>99.8%</b> | "
            "ОКНО СВЯЗИ: 14:00 - 18:30 UTC")
        b.addWidget(self.comm_info)
        return f

    def refresh_astro(self):
        snap = self.astro.snapshot()
        el = snap["elongation"]
        self.solar_info.setText(
            f"СОЛНЕЧНЫЕ БАТАРЕИ (Solar Array) | УГОЛ К СОЛНЦУ: <b>{el:.1f}°</b> | "
            f"ЗАРЯД: 91% | РАССТОЯНИЕ ДО ЛУНЫ: {snap['moon_km']:,.0f} км")

        ax = self.ax_solar
        ax.clear()
        ax.set_facecolor(PANEL_BG)
        ax.set_aspect("equal")
        ax.axis("off")
        ax.set_xlim(-6, 6)
        ax.set_ylim(-4, 4)

        ax.add_patch(Ellipse((0, 0), 10, 6, fill=False, ec="#cfd6ea", lw=1))
        ax.add_patch(Circle((0, 0), 1.0, color="#2f6fd0"))
        ax.add_patch(Circle((-0.3, 0.3), 0.55, color="#2f9a5a", alpha=0.7))

        # Луна: угол от направления на Солнце (Солнце — справа, +X)
        a = np.radians(el)
        mx, my = 5 * np.cos(a), -3 * np.sin(a)
        ax.add_patch(Circle((mx, my), 0.35, color="#9a9a9a"))
        ax.text(mx, my - 0.7, "СОЛНЕЧНЫЕ\nБАТАРЕИ", color=TEXT, ha="center", fontsize=8)
        ax.add_patch(Circle((5.6, 3.2), 0.45, color="#ffcc00"))
        ax.plot([0, 4.5], [0, 0], ls="--", color="#ffcc00", lw=0.6)
        ax.plot([0, mx], [0, my], ls="--", color="#cfd6ea", lw=0.6)
        ax.text(1.6, -0.5, f"{el:.0f}°", color=TEXT, fontsize=11)
        ax.text(-2.5, -2.3, "СВ936", color=TEXT, fontsize=9)
        ax.plot([-2.5], [-2.0], marker="s", color="#4a8cff")
        self.fig_solar.tight_layout(pad=0.2)
        self.fig_solar.canvas.draw_idle()

    # ---------------------------------------------------------- топография (Matplotlib)
    def _topo_panel(self):
        f, b = make_panel("ТОПОГРАФИЯ")
        b.addWidget(QtWidgets.QLabel("<b>КРАТЕР ШЕКЛТОН</b> — топография (Ящеричий посадки)"))
        fig, cv = mpl_canvas(5, 3)
        ax = fig.add_subplot(111)
        X, Y, Z = crater_dem()
        im = ax.pcolormesh(X, Y, Z, cmap="jet", shading="auto")
        ax.contour(X, Y, Z, levels=14, colors="white", linewidths=0.5, alpha=0.8)
        ax.plot(0, 0, "o", ms=4, mfc="none", mec="white")
        ax.plot(3.0, -4.0, "r*", ms=10)
        ax.text(3.3, -4.0, "посадка B4", color="white", fontsize=8)
        ax.tick_params(colors=TEXT, labelsize=7)
        ax.set_xlabel("км", color=TEXT, fontsize=7)
        ax.set_aspect("equal")
        fig.colorbar(im, ax=ax, label="высота, км").ax.yaxis.label.set_color(TEXT)
        fig.tight_layout(pad=0.5)
        b.addWidget(cv, 1)
        b.addWidget(QtWidgets.QLabel(
            f"МАКС. ПЕРЕПАД: {Z.max() - Z.min():.0f} м (модель). "
            "ПРЕДПОЛАГАЕМЫЙ УЧАСТОК ПОСАДКИ. СЕКТОР B4."))
        return f

    # ---------------------------------------------------------- маршрут до Луны
    def _route_panel(self):
        f, b = make_panel("ROUTE TO MOON / COORDINATES")
        row = QtWidgets.QHBoxLayout()
        self.btn_route = QtWidgets.QPushButton("МАРШРУТ ДО ЛУНЫ")
        self.btn_coord = QtWidgets.QPushButton("КООРДИНАТЫ")
        for btn in (self.btn_route, self.btn_coord):
            btn.setCheckable(True)
            row.addWidget(btn)
        self.btn_route.setChecked(True)
        self.btn_route.clicked.connect(lambda: self.set_mode("route"))
        self.btn_coord.clicked.connect(lambda: self.set_mode("coords"))
        b.addLayout(row)

        self.fig_route, cv = mpl_canvas(5, 2.6)
        self.ax_route = self.fig_route.add_subplot(111)
        b.addWidget(cv, 1)

        self.stage = QtWidgets.QProgressBar()
        self.stage.setFormat("СТАДИЯ: TLI")
        self.stage.setStyleSheet(
            "QProgressBar{border:1px solid #888;text-align:center;}"
            f"QProgressBar::chunk{{background:{RED};}}")
        b.addWidget(self.stage)

        self.coords = QtWidgets.QLabel()
        self.coords.setTextFormat(QtCore.Qt.RichText)
        b.addWidget(self.coords)

        btns = QtWidgets.QHBoxLayout()
        for name, fn in (("ОТПРАВИТЬ ДАННЫЕ", self.send_data),
                         ("ПЕРЕРАСЧЁТ", self.recalc),
                         ("ОБНОВИТЬ КАРТУ", self.refresh_astro),
                         ("ВЫХОД", self.close)):
            bt = QtWidgets.QPushButton(name)
            bt.clicked.connect(fn)
            btns.addWidget(bt)
        b.addLayout(btns)
        return f

    @staticmethod
    def trajectory(n=200):
        """Упрощённая траектория 'свободного возврата' в плоскости Земля–Луна."""
        x = np.linspace(0, 10, n)
        y_out = 1.6 * np.sin(np.pi * x / 10) ** 0.8
        y_back = -1.6 * np.sin(np.pi * x / 10) ** 0.8
        return x, y_out, y_back

    def draw_route(self):
        ax = self.ax_route
        ax.clear()
        ax.set_facecolor(PANEL_BG)
        ax.axis("off")
        ax.set_aspect("equal")
        ax.set_xlim(-2, 12.5)
        ax.set_ylim(-3, 3)

        ax.add_patch(Circle((0, 0), 1.0, color="#2f6fd0"))
        ax.add_patch(Circle((0, 0), 1.35, fill=False, ec="#cfd6ea", lw=0.8))
        ax.add_patch(Circle((11, 0), 0.6, color="#9a9a9a"))

        x, yo, yb = self.trajectory()
        ax.plot(x, yo, color="white", lw=1.5)
        ax.plot(x, yb, color="white", lw=1, ls="--")
        i = int(self.progress * (len(x) - 1))
        ax.plot(x[i], yo[i], "s", color="red", ms=6)
        ax.text(x[i], yo[i] + 0.5, f"T {self.hours:.2f} ч", color=TEXT, fontsize=8, ha="center")
        ax.text(11, 1.0, "СБЛИЖЕНИЕ", color=TEXT, ha="center", fontsize=8)
        self.fig_route.tight_layout(pad=0.2)
        self.fig_route.canvas.draw_idle()

    # ---------------------------------------------------------- действия
    def set_mode(self, mode):
        self.route_mode = mode
        self.btn_route.setChecked(mode == "route")
        self.btn_coord.setChecked(mode == "coords")
        self.ax_route.set_visible(mode == "route")
        self.fig_route.canvas.draw_idle()

    def send_data(self):
        QtWidgets.QMessageBox.information(self, "Телеметрия", "Пакет данных отправлен на DSN-48.")

    def recalc(self):
        self.progress = min(self.progress, 0.35)
        self.refresh_astro()

    # ---------------------------------------------------------- обновление раз в секунду
    def tick(self):
        # часы миссии
        s = self.t0.secsTo(QtCore.QDateTime.currentDateTime()) + 20 * 60 + 15
        self.clock.setText(f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}")

        # телеметрия (имитация)
        self.snr = np.roll(self.snr, -1)
        self.delay = np.roll(self.delay, -1)
        self.snr[-1] = np.clip(self.snr[-2] + self.rng.normal(0.2, 3), 20, 95)
        self.delay[-1] = np.clip(self.delay[-2] + self.rng.normal(0, 1.2), 10, 35)
        self.curve_snr.setData(self.snr)
        self.curve_delay.setData(self.delay)
        self.tel_label.setText(
            f"ТЕЛЕМЕТРИЯ: <span style='color:{GREEN}'><b>ОК.</b></span> "
            f"СТАТУС: <span style='color:{GREEN}'><b>ВКЛ.</b></span> "
            f"| S/N {self.snr[-1]:.0f} дБ | {self.delay[-1]:.0f} мс")

        # положение аппарата
        self.progress = min(1.0, self.progress + 0.0005)
        self.hours = self.progress * self.TOTAL_HOURS
        lat = -1.23 + 0.001 * s % 5
        lon = 15.56 + 0.002 * s % 10
        alt = 1540 + 800 * self.progress
        self.stage.setValue(int(self.progress * 100))
        self.coords.setText(
            "<b>КООРДИНАТЫ АППАРАТА</b> (Manned Craft)<br>"
            f"ШИРОТА: {lat:.2f}° | ДОЛГОТА: {lon:.2f}° | ВЫСОТА: <b>{alt:.0f} км</b><br>"
            "ЦЕЛЬ: ШИРОТА -89.4° | ДОЛГОТА +12.0°")
        if self.route_mode == "route":
            self.draw_route()

        # Астрономия пересчитываем раз в минуту
        if s % 60 == 0:
            self.refresh_astro()


if __name__ == "__main__":
    app = QtWidgets.QApplication(sys.argv)
    w = Dashboard()
    w.show()
    sys.exit(app.exec_())
