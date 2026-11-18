# Wielkość interfejsu

## Po co

Na Linuksie napisy wokół terminali (pasek górny i dolny, panele, Opcje, okienka) są za małe,
a terminale mają dobry rozmiar (mają własne ustawienie: Opcje → Terminal → Czcionka, ⌘= / ⌘-).

## Sposoby (wybrany: B)

- A. Powiększenie całego okna (zoom webview) — skaluje też terminale. Odrzucony przez użytkownika.
- **B. Tylko interfejs, bez terminali (wybrany).** Rozmiary w CSS przechodzą na zmienną `--ui-scale`.

## Jak działa

- Opcje → Wygląd → „Wielkość interfejsu”: 90% · 100% · 110% · 125% · 150% (ten sam styl
  przełącznika `seg` co inne wybory w Opcjach). Działa od razu, bez restartu.
- Zapis: `layout.json` pole `uiScale` (liczba, domyślnie `1`); wartości spoza listy → `1`.
  Stare pliki bez pola działają bez zmian. Pole też w Rust `Layout` (inaczej zapis z Rusta je gubi).
- CSS: `:root { --ui-scale: 1 }`, ustawiane z TS na `document.documentElement`. Wszystkie
  rozmiary napisów w px w `src/styles.css` → `calc(<N>px * var(--ui-scale))`; tak samo wysokości
  pasków, przycisków, ikon i odstępy, które w px ucinałyby powiększony tekst.
- Nie skalujemy: terminali w kafelkach (xterm, ich czcionka z `layout.fontSize`) ani natywnego
  podglądu stron w panelu plików.

## Czego nie robimy

Skrótu klawiszowego (może później), skalowania terminali, osobnej skali dla poszczególnych paneli.

## Testy

Wartości dozwolone i domyślna (czysta funkcja), zapis/odczyt `uiScale` w Rust (stary plik →
domyślna), ustawienie zmiennej CSS. Ręcznie: 150% na Linuksie — nic się nie ucina, terminale bez zmian.
