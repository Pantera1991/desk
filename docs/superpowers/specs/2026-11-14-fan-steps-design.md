# Stopnie wiatraków

## Po co

Tryb z wiatrakami (zob. `2026-11-14-fans-on-overheat-design.md`) zna dziś jedną reakcję: od progu
wszystkie wiatraki na pełne 6800 obr./min, 7°C niżej z powrotem auto. Chłodzi najlepiej, ale jest
najgłośniejsze, a przy lekkim przegrzaniu wystarczyłoby mniej. Właściciel chce ustawiać **progi
obrotów**: np. od 65°C pół mocy, od 72°C 70%, od 80°C pełne obroty.

Z trzech makiet (stopnie w tabeli, krzywa z punktami do przeciągania, rampa między dwiema
temperaturami) wybrał **stopnie**.

## Cele

- Opcje → Zasilanie → Temperatura: tabela **Stopnie wiatraków**, od 1 do 4 wierszy
  „od [°C] → [obroty %]”. Próg 50–100°C, obroty 40–100% maksimum co 10.
- Wejście na stopień od razu, gdy średnia temperatura (jak dziś: 3 odczyty co 5 s) dojdzie do jego
  progu; kilka stopni naraz też. Zejście niżej dopiero 7°C pod progiem stopnia i nie wcześniej niż
  minutę po ostatniej zmianie. Poniżej pierwszego stopnia (−7°C) auto, czyli macOS.
- Chip w pasku: `74° ≋ 70%`; podpowiedź mówi, który to stopień, ile obrotów, kiedy wyżej i kiedy
  w dół.
- Tryby „Przy przegrzaniu”: cztery zamiast pięciu (decyzja właściciela):
  `Nic | Zwalniaj sesje | Wiatraki i zwalnianie | Tylko wiatraki`.
  „Wiatraki, potem zwalnianie” znika, bo kolejność wynika już z tabeli (pierwszy stopień poniżej
  progu zwalniania albo nie).
- Nikomu nie zmienia się zachowanie po aktualizacji (migracja niżej).

## Czego nie robimy

- Krzywej ani rampy (makiety B i C odrzucone), dowolnych procentów, osobnych obrotów dla każdego
  wiatraka (wszystkie dostają ten sam procent swojego maksimum).
- Progu „nie wolniej niż macOS w chwili przejęcia”. Rozważony i odrzucony: najniższe 40% (2720
  obr./min na M3 Pro) i tak jest powyżej minimum macOS (2317).
- Toastów przy każdej zmianie stopnia (za dużo szumu). Toasty zostają tylko przy starcie wiatraków
  i powrocie do auto, jak dziś.

## Czego nie wolno zepsuć (anty-cele)

- **Wiatraki tylko na wyraźne życzenie.** Domyślny tryb dalej „Zwalniaj sesje”. Migracja,
  aktualizacja ani pierwszy start nie włączają wiatraków i nie instalują helpera. Nic nie zachęca
  do ich włączenia.
- **Wiatrak nigdy nie zostaje ręczny, gdy desk już nim nie steruje**: znacznik `fans-forced`,
  strażnik, `auto` przy starcie ze znacznikiem i przy usuwaniu zgody działają jak dziś.
- **desk nie walczy z innym programem**: wiatraki ręczne, których nie ustawił, zostawia.
- **Wiatraki nie „pływają”**: histereza 7°C i minuta między zmianami.
- Reguła sudoers dalej wylicza **dokładne** polecenia, bez symboli wieloznacznych.

## Podejścia

### Wygląd (wybrane: stopnie)

| | Za | Przeciw |
|---|---|---|
| **A. Stopnie** (wybrane) | Pasuje do „progów”; stałe poziomy, przewidywalny hałas; każdy stopień to dzisiejszy próg wiatraków z własną prędkością; stare ustawienie przechodzi 1:1 (jeden stopień → 100%); krótka lista poziomów w sudoers | Skoki obrotów między stopniami |
| B. Krzywa | Najwięcej kontroli | Mozolna w ciasnym panelu; płynne obroty trzeba wygładzać; więcej poziomów w sudoers |
| C. Rampa | Dwie liczby | Obroty zmieniają się co kilka stopni; mniej kontroli |

### Jak helper ustawia niższe obroty (wybrane: lista poziomów)

1. **`level N` z listą w sudoers** (wybrane): reguła wylicza `level 40`, `level 50` … `level 100`
   i `auto`. Nic innego nie przejdzie.
2. `level *` w sudoers i sprawdzanie w helperze: odrzucone, bo cała ochrona wisiałaby na
   parsowaniu argumentów w helperze.
3. Tylko `max`/`auto` i „poziomy” przez przełączanie: odrzucone, wiatraki by pulsowały.

## Projekt

### Helper `desk-fans` (PROTOCOL 3)

- Polecenia: `level N` (N ∈ {40, 50, …, 100}), `auto`, `version`, `probe`. **`max` znika**;
  zastępuje go `level 100`. Każdy inny argument (np. `level 45`, `level 100x`) kończy się kodem 2
  bez dotykania SMC.
- `fan_control::force_level(smc, percent, pause)` uogólnia dzisiejsze `force_max`: cel każdego
  wiatraka = `max(Mx × percent / 100, Mn)`, gdzie `Mn` (`F%dMn`) to jego minimum; jeśli `Mn` się
  nie czyta, samo `Mx × percent / 100`. Te same rundy z odczytem i ta sama ścieżka M1–M4 (`Ftst`)
  i M5 (`Keys`), co w `force_max` po poprawce z PR 43. Weryfikacja porównuje z tym celem (±1 obr.).
- Zmiana poziomu, gdy wiatraki już są desk-a: to samo wywołanie (`level N`); tryb ręczny pisze się
  ponownie (nieszkodliwe), cel się zmienia. Każda porażka kończy się auto, jak dziś.
- `PROTOCOL = 3`: zainstalowana zgoda z wersji 2 to „zgoda z poprzedniej wersji”, a desk raz
  prosi o hasło (dotyczy tylko tych, którzy włączyli wiatraki w 0.1.38).

### Reguła sudoers

```
<user> ALL=(root) NOPASSWD: HELPER level 40, HELPER level 50, HELPER level 60, HELPER level 70, HELPER level 80, HELPER level 90, HELPER level 100, HELPER auto
```

Nowe ryzyko, opisane w README: każdy program tego użytkownika może teraz ustawić wiatraki
**niżej** niż macOS (najniżej 40%) i zostawić je ręcznie. Przed przegrzaniem i tak chroni macOS
(dławienie procesora). Dotąd reguła pozwalała tylko na kierunek bezpieczny (maksimum).

### Ustawienia (`layout.json`)

- Nowe pole `fanSteps: [{ "celsius": 65, "percent": 50 }, …]` zastępuje `fanLimit`. Domyślnie
  `[{ "celsius": 70, "percent": 100 }]`, czyli dzisiejsze zachowanie.
- Poprawne kroki: 1–4, `celsius` 50–100 ściśle rosnąco, `percent` z {40, 50, …, 100}
  niemalejąco. Przy wczytaniu desk naprawia kroki (sortuje, przycina zakresy, zaokrągla procent do
  10, usuwa duplikaty progów, obcina do 4, procent mniejszy niż we wcześniejszym stopniu podnosi do
  tamtego; pusta lista → domyślna). Opcje zapisują tylko poprawną
  tabelę; przy błędzie pokazują czerwony komunikat i nie zapisują.
- Tryby: `off | slow | together | fans`. Klucz `together` zostaje, z etykietą „Wiatraki
  i zwalnianie”.
- Migracja (bez zmiany zachowania):

| Było | Jest |
|---|---|
| `thermalLimit: 0` (bardzo stary zapis) | `off`, próg 75 (jak dziś) |
| `fansFirst`, `fanLimit: F`, `thermalLimit: L` | `together`, `fanSteps: [{min(F, L), 100}]` (próg, który działa dziś; przycięty do 50–100) |
| `together`, `thermalLimit: L` | `together`, `fanSteps: [{L, 100}]` |
| `fans`, `thermalLimit: L` | `fans`, `fanSteps: [{L, 100}]` |
| inny tryb, brak `fanSteps` | `fanSteps` domyślne |

  `thermalLimit` zostaje progiem zwalniania (w trybie `fans` nieużywany, ale zapamiętany).

### Decyzja o stopniu (thermal.rs)

- Drugi `Policy` (ten od wiatraków) zamienia się w politykę stopni: zamiast „tak/nie” zwraca
  numer stopnia albo nic (auto).
- **W górę:** cel = najwyższy stopień, którego próg ≤ średnia; jeśli wyższy niż obecny, od razu.
- **W dół:** stopień k schodzi, gdy średnia ≤ próg(k) − 7 i od ostatniej zmiany minęła minuta.
  Schodzi wprost na najwyższy stopień j, dla którego średnia > próg(j) − 7, albo do auto, gdy
  takiego nie ma.
- „Za gorąco” od systemu (thermal pressure): najwyższy stopień.
- **Zmiana tabeli, gdy desk trzyma stopień** (usunięty wiersz, gotowy zestaw, niższy procent):
  stopień liczy się od nowa według nowej tabeli; w górę od razu, w dół dalej czeka na 7°C i minutę.
- Zwalnianie sesji bez zmian, od `thermalLimit` (tryby `slow` i `together`).

### Wiatraki w czasie pracy (fans.rs)

- `Fans::step` dostaje żądany procent (`Option<u8>`) zamiast `bool`. Desk pamięta procent, który
  ostatnio ustawił; inny żądany procent → `level N` od razu. Minuta przerwy obowiązuje tylko po
  porażce albo gdy ustawienie zginęło (np. po uśpieniu wiatraki znów w auto). Inny program,
  znacznik, strażnik i `release` jak dziś.
- Gdy desk chce stopnia, a nie może sterować (brak zgody, inny program, przerwa po porażce): chip
  i „● teraz” pokazują procent, który desk **faktycznie** ustawił (albo nic); podpowiedź mówi, który
  stopień desk chce i dlaczego go nie ma.
- `FanStatus.forced: bool` → `percent: Option<u8>` (ustawiony przez desk); `rpm`, `max_rpm`,
  `problem` jak dziś.
- `fans::Info` dostaje `max_rpm` (do podpowiedzi „≈ 4760 obr./min” w Opcjach); `None`, gdy
  wiatraków nie da się odczytać.

### Wygląd

#### Opcje → Zasilanie → Temperatura

```
TEMPERATURA
Przy przegrzaniu  [Nic] [Zwalniaj sesje] [Wiatraki i zwalnianie] [Tylko wiatraki]
Próg zwalniania   [85] °C                       (tryby slow i together)

Stopnie wiatraków                                (tryby together i fans)
  od [65] °C → [50% ▾]  ≈ 3400 obr./min              [✕]
  od [72] °C → [70% ▾]  ≈ 4760 obr./min  ● teraz     [✕]
  od [80] °C → [100% ▾] ≈ 6800 obr./min              [✕]
  [+ Dodaj stopień]   Gotowe: [Jak dotąd (70° → 100%)] [Cicho] [Chłodno]
  (wykres: oś 50–100°C, schodki obrotów, pole „auto (macOS)” przed pierwszym progiem,
   kreska „zwalnianie” na progu zwalniania, kreska „teraz” na bieżącej temperaturze)
Zgoda na wiatraki jest zainstalowana (auto i obroty 40–100%). [Usuń zgodę]
<opis: zejście 7°C niżej, nie częściej niż co minutę; poniżej pierwszego progu auto; inny program>
```

- Gotowe zestawy: **Jak dotąd** `[{70,100}]`, **Cicho** `[{72,50},{80,70},{88,100}]`,
  **Chłodno** `[{60,60},{68,80},{75,100}]`.
- „+ Dodaj stopień”: próg ostatniego + 6 (≤ 100), obroty ostatniego + 10 (≤ 100); nieaktywne przy
  4 wierszach. „✕” nieaktywne przy jednym wierszu.
- „● teraz” przy stopniu, który desk właśnie trzyma (z `ThermalStatus`).
- Wybór trybu z wiatrakami bez zgody: jak dziś, najpierw instalacja z hasłem.

#### Chip i podpowiedź

- Chip: `74° ≋ 70%`, przy zwalnianiu `86° ≋ 100% ↓`.
- Podpowiedź (przykład):
  `Procesor: 74°C.` / `Wiatraki: stopień 2 z 3, 70% (4760 obr./min).` /
  `Wyżej: od 80°C → 100%.` / `W dół: przy 65°C → 50%, auto poniżej 58°C.`
- Toasty: start wiatraków („Procesor ma 72°C: wiatraki na 70%”) i powrót do auto, jak dziś.

### README

Wiersz „Temperatura” (cztery tryby, stopnie) i punkt bezpieczeństwa „Wiatraki (macOS)” (lista
poziomów w sudoers i nowe ryzyko). CHANGELOG dopisuje commit wydania.

## Testy

- `fan_control`: `force_level` (cel z procentu, podłoga `Mn`, M1–M4 i M5, odczyt do skutku,
  porażka → auto).
- Helper: parsowanie `level N` (dobre, złe, brak argumentu → kod 2, bez SMC).
- Polityka stopni: w górę od razu i o kilka stopni, w dół z histerezą i minutą, prosto na właściwy
  stopień, thermal pressure → najwyższy, brak odczytu.
- `Fans`: zmiana procentu → `level`, ten sam procent → nic, inny program, ponawianie, `release`.
- `layout`: każdy wiersz tabeli migracji, naprawa złych kroków.
- `sudoers_rule`: dokładna lista poleceń.
- vitest: chip, podpowiedź, toasty, walidacja tabeli, zestawy, dodawanie i usuwanie stopni.
- Sprzęt (M3 Pro): `level 50`, `level 70`, `level 100`, `auto`, obroty z `desk-fans probe`;
  potem desk z trzema stopniami pod obciążeniem.

## Ograniczenia

- Ten plan opiera się na PR 43 (helper z rundami, `Keys`, `probe`, PROTOCOL 2); zaczyna się po
  jego merge'u albo na jego gałęzi.
- M5 nadal niesprawdzone na sprzęcie; temperatura na M5 (czujniki `PMU tdie*`) też.

## Decyzje podjęte przy spisywaniu (do sprawdzenia przez właściciela)

- `max` w helperze zastępuje `level 100` (krótsza reguła, jedno polecenie do wymuszania).
- Poziomy co 10% od 40%; cel nie niżej niż minimum wiatraka (`Mn`).
- W dół od razu na właściwy stopień (nie po jednym na minutę), z minutą między zmianami.
- Bez toastów przy zmianie stopnia.
- Klucz trybu `together` zostaje; `fansFirst` przechodzi w niego.
- Wykres w Opcjach jak w makiecie.
- W trybie „Tylko wiatraki” pole progu zwalniania jest ukryte.
- Zmiana tabeli przy trzymanym stopniu: przeliczenie od nowa, w górę od razu, w dół z histerezą.
- Zmiana procentu od razu; minuta przerwy tylko po porażce albo utracie ustawienia.
- Chip pokazuje procent faktycznie ustawiony, nie żądany.
- Migracja `fansFirst`: próg `min(fanLimit, thermalLimit)`, bo taki działa dziś.

## Zostawione builderowi

Nazwy typów i funkcji, podział na pliki, angielskie wersje tekstów, wygląd wykresu w szczegółach
(byle czytelny w ciemnym motywie i przy 11 px), kolejność zadań w planie.
