FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV DATA_DIR=/data HOST_ROOT=/host PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 32500 32501
# Il server parte dai file della cartella di BunkerPlex (montata in /programma):
# cosi' un aggiornamento scaricato da GitHub vale al riavvio, senza ricostruire
# l'immagine. Se il disco non e' collegato o quei file sono rovinati, parte la
# copia che sta dentro l'immagine (/app).
CMD ["sh", "-c", "if python -m py_compile /programma/server/app.py /programma/server/updater.py /programma/server/accounts.py 2>/dev/null; then cd /programma/server; fi; exec uvicorn app:app --host 0.0.0.0 --port 32500"]
