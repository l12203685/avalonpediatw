from flask import Flask
from threading import Thread

app = Flask('')

@app.route('/')
def main():
	return 'discord to line bot is on!'

def run():
    app.run(host="0.0.0.0", port=6238)

def keep_alive():
    server = Thread(target=run)
    server.start()