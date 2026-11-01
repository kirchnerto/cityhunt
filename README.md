# Straßenjagd Würzburg

Jede Straße in Würzburg einmal zu Fuß laufen. Die App zeichnet Spaziergänge per GPS auf, zeigt live, ob du gerade eine neue Straße läufst, und berechnet den Fortschritt für die ganze Stadt und jeden Stadtbezirk.

## Online stellen mit GitHub Pages (ca. 5 Minuten)

1. Auf github.com oben rechts **+ → New repository**. Name z. B. `strassenjagd`, **Public**, Haken bei „Add a README" weglassen, **Create repository**.
2. Auf der leeren Repo-Seite auf **uploading an existing file** klicken.
3. Alle Dateien aus diesem Ordner hineinziehen (`index.html`, `core.js`, `sw.js`, `manifest.webmanifest`, die drei `icon-…png` und diese `README.md`), dann **Commit changes**.
4. Im Repo **Settings → Pages**. Bei „Source" **Deploy from a branch** wählen, Branch **main**, Ordner **/ (root)**, **Save**.
5. Nach 1–2 Minuten steht oben auf der Pages-Seite die Adresse, z. B. `https://deinname.github.io/strassenjagd/`.

## Auf dem Pixel einrichten

1. Die Adresse in **Chrome** öffnen.
2. **Straßen von Würzburg laden** tippen (einmalig, braucht Internet).
3. Chrome-Menü (⋮) → **App installieren** bzw. **Zum Startbildschirm hinzufügen**. Ab dann startet sie wie eine normale App.
4. Beim ersten **Spaziergang starten** den Standortzugriff erlauben (am besten „Genau").

## Unterwegs

- Die App muss **im Vordergrund und das Display an** bleiben, sonst stoppt Android die Ortung. Die App hält das Display automatisch wach; Helligkeit runterdrehen spart Akku.
- Oben steht die Straße, auf der du gerade bist, wie ein Straßenschild. Darunter: **Neue Straße**, **Neues Stück** oder **Schon gelaufen**. Bei einer neuen Straße vibriert das Handy kurz.
- Tippe auf eine Straße in der Karte, um Name und Fortschritt zu sehen.
- Wird die App mitten im Spaziergang geschlossen, geht nichts verloren: Beim nächsten Öffnen läuft die Aufzeichnung weiter.

## Regeln

- Gezählt werden alle **benannten Straßen** im Stadtgebiet Würzburg aus OpenStreetMap, ohne Privatwege. Benannte Fußwege, Treppen und Pfade lassen sich in den Einstellungen dazuschalten.
- Eine Straße ist in Abschnitte von etwa 20 m geteilt. Die App sucht den plausibelsten Weg durchs Straßennetz: nah an deiner GPS-Spur, passend zu deiner Laufrichtung und zusammenhängend über Kreuzungen. Gezählt wird nur, was auf diesem Weg liegt. An einer Einmündung vorbeigehen oder parallel zu einer Nachbarstraße laufen zählt also nicht. Bei getrennten Fahrbahnen derselben Straße zählen beide Seiten.
- Nach dem Beenden wird der ganze Spaziergang noch einmal ausgewertet. Das Ergebnis kann daher minimal von der Live-Anzeige abweichen.
- Eine Straße ist **fertig** ab 90 % ihrer Länge.

## Datenschutz

Spaziergänge werden nur im Speicher von Chrome auf deinem Handy gespeichert. Es gibt keinen Server und kein Konto. Straßendaten kommen von der Overpass-API (OpenStreetMap), Kartenbilder ebenfalls von OpenStreetMap.

**Wichtig:** Wenn du in Chrome die Websitedaten löschst, sind auch die Spaziergänge weg. Deshalb ab und zu unter *Fortschritt → Backup speichern* sichern. Mit *Backup laden* holst du sie zurück, auch auf ein neues Handy.

## Andere Apps

Unter *Fortschritt → GPX importieren* lassen sich Aufzeichnungen aus Strava, Komoot, Garmin & Co. nachträglich einlesen.

Straßendaten © OpenStreetMap-Mitwirkende, ODbL.
