import random
from typing import List

roles = ["梅林", "派西維爾", "莫德雷德", "刺客", "壞人", "平民"]

def assign_roles(players: List[str]) -> dict:
    random.shuffle(players)
    return {player: roles[i] for i, player in enumerate(players)}
