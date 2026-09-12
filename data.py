import json
import os

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_JSON_PATH = os.path.join(ROOT_DIR, "data.json")
TREE_JSON_PATH = os.path.join(ROOT_DIR, "tree.json")

def load_cached_data():
    if os.path.exists(DATA_JSON_PATH) and os.path.exists(TREE_JSON_PATH):
        with open(DATA_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        with open(TREE_JSON_PATH, "r", encoding="utf-8") as f:
            tree = json.load(f)
        print(f"Loaded {len(data)} files across {len(tree)} semesters from local cache.")
        return {"data": data, "tree": tree}
    else:
        print("Local data cache not found.")
        return None

if __name__ == "__main__":
    load_cached_data()
