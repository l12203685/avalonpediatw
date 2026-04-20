"""
Avalon Board Game Data Analysis System
avalonpediatw - 阿瓦隆百科 統計分析

Data: 2145+ games, 60+ players
Sources:
  - Aggregate stats: staging/avalon_stats_raw.txt
  - Per-game data: Google Sheets (牌譜, 同贏/同輸, 1-1, 局勢分析)
Author: Edward (林盈宏)
"""

import sys
import os
import warnings
warnings.filterwarnings('ignore')

from typing import Any

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib
matplotlib.rcParams['font.sans-serif'] = ['Microsoft JhengHei', 'SimHei', 'Arial Unicode MS']
matplotlib.rcParams['axes.unicode_minus'] = False

from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

# --- Configuration ---
RAW_DATA_PATH = Path(r"C:\Users\admin\GoogleDrive\staging\avalon_stats_raw.txt")
OUTPUT_DIR = Path(r"C:\Users\admin\GoogleDrive\專案\avalonpediatw\analysis\output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MIN_GAMES_THRESHOLD = 50  # minimum games for statistical relevance

# Google Sheets config
SHEETS_CREDENTIALS = Path(r"C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\avalonpediatw-gs-api-credentials.json")
NEW_SHEET_ID = "174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU"
OLD_SHEET_ID = "13Mm_sZYQ9EOjrKd-NGLoIr_0B_t_KEMsb9tQEbU5oWE"

# Role config: position in 配置 string -> role name
CONFIG_ROLE_ORDER = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林']
ROLE_ABBR = {'刺客': '刺', '莫甘娜': '娜', '莫德雷德': '德', '奧伯倫': '奧', '派西維爾': '派', '梅林': '梅', '忠臣': '忠'}
ABBR_TO_ROLE = {v: k for k, v in ROLE_ABBR.items()}

RED_ROLES = {'刺客', '莫甘娜', '莫德雷德', '奧伯倫'}
BLUE_ROLES = {'派西維爾', '梅林', '忠臣'}

# Vision roles: roles that can see other players' identities
VISION_ROLES = {'梅林', '派西維爾', '莫甘娜', '奧伯倫'}  # Merlin sees evil (except Mordred), Percival sees Merlin+Morgana, Morgana seen by Percival, Oberon sees nothing but is evil
MERLIN_VISION = True  # Merlin sees all evil except 莫德雷德(Mordred)


# =============================================================================
# 0. GOOGLE SHEETS CONNECTION
# =============================================================================

def connect_sheets() -> gspread.Spreadsheet:
    """Connect to Google Sheets using service account credentials."""
    scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly']
    creds = Credentials.from_service_account_file(str(SHEETS_CREDENTIALS), scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(NEW_SHEET_ID)


def load_game_log(sh: gspread.Spreadsheet) -> pd.DataFrame:
    """Load the 牌譜 (game log) sheet into a DataFrame with decoded roles."""
    ws = sh.worksheet('牌譜')
    rows = ws.get_all_values()
    headers = rows[0]
    data = rows[1:]

    df = pd.DataFrame(data, columns=headers)
    df = df[df['流水號'].str.strip().astype(bool)].copy()
    df = df[df['配置'].str.len() == 6].copy()

    # Decode role config: each position maps to a role
    def decode_config(config: str) -> dict[str, str]:
        seat_role: dict[str, str] = {}
        for i, digit in enumerate(config):
            seat_role[digit] = CONFIG_ROLE_ORDER[i]
        for s in '1234567890':
            if s not in seat_role:
                seat_role[s] = '忠臣'
        return seat_role

    df['seat_roles'] = df['配置'].apply(decode_config)

    # Parse lake transfers
    def parse_lake(lake_str: str) -> tuple[str, str] | None:
        if not lake_str or '>' not in lake_str:
            return None
        lake_str = lake_str.replace('x', '')  # remove 'x' suffix (failed check)
        parts = lake_str.split('>')
        if len(parts) == 2:
            return (parts[0].strip(), parts[1].strip())
        return None

    df['lake1_parsed'] = df['首湖'].apply(parse_lake)
    df['lake2_parsed'] = df['二湖'].apply(parse_lake)
    df['lake3_parsed'] = df['三湖'].apply(parse_lake)

    # Extract faction from role
    def role_faction(role: str) -> str:
        if role in RED_ROLES:
            return '紅方'
        return '藍方'

    # Determine holder and target factions for each lake use
    # NOTE: X玩家 columns contain the HOLDER's role abbreviation, not the target's.
    # We derive both holder and target roles from seat_roles + the parsed lake transfer.
    for lake_col, parsed_col in [
        ('首湖', 'lake1_parsed'),
        ('二湖', 'lake2_parsed'),
        ('三湖', 'lake3_parsed'),
    ]:
        holder_faction_list = []
        target_faction_list = []
        holder_role_list = []
        target_role_list = []
        for _, row in df.iterrows():
            parsed = row[parsed_col]
            if parsed is None:
                holder_faction_list.append('')
                target_faction_list.append('')
                holder_role_list.append('')
                target_role_list.append('')
                continue
            holder_seat, target_seat = parsed
            roles = row['seat_roles']
            holder_role = roles.get(holder_seat, '')
            target_role = roles.get(target_seat, '')
            holder_faction_list.append(role_faction(holder_role) if holder_role else '')
            target_faction_list.append(role_faction(target_role) if target_role else '')
            holder_role_list.append(holder_role)
            target_role_list.append(target_role)
        df[f'{lake_col}_holder_faction'] = holder_faction_list
        df[f'{lake_col}_target_faction'] = target_faction_list
        df[f'{lake_col}_holder_role'] = holder_role_list
        df[f'{lake_col}_target_role'] = target_role_list

    # Parse 1-1 team seats
    df['r11_seats'] = df['1-1'].apply(lambda x: list(x) if x else [])

    # Determine which roles are in the 1-1 team
    def r11_roles(row: pd.Series) -> list[str]:
        seats = row['r11_seats']
        roles = row['seat_roles']
        return [roles.get(s, '?') for s in seats]

    df['r11_roles'] = df.apply(r11_roles, axis=1)

    # Has vision in 1-1: Merlin can identify evil
    def r11_has_merlin(roles: list[str]) -> bool:
        return '梅林' in roles

    df['r11_has_merlin'] = df['r11_roles'].apply(r11_has_merlin)

    # Has Percival in 1-1
    def r11_has_percival(roles: list[str]) -> bool:
        return '派西維爾' in roles

    df['r11_has_percival'] = df['r11_roles'].apply(r11_has_percival)

    # Count red/blue in 1-1 team
    def count_faction_in_team(roles: list[str], faction_set: set[str]) -> int:
        return sum(1 for r in roles if r in faction_set)

    df['r11_red_count'] = df['r11_roles'].apply(lambda r: count_faction_in_team(r, RED_ROLES))
    df['r11_blue_count'] = df['r11_roles'].apply(lambda r: count_faction_in_team(r, BLUE_ROLES))

    # Mission results: 'ooo' means all pass, 'oox' means 2 pass 1 fail
    def count_mission_fails(mission_str: str) -> int:
        if not mission_str:
            return 0
        return mission_str.count('x')

    for i in range(1, 6):
        col = f'第{["一","二","三","四","五"][i-1]}局成功失敗'
        df[f'mission{i}_fails'] = df[col].apply(count_mission_fails)
        df[f'mission{i}_total'] = df[col].apply(lambda x: len(x) if x else 0)

    # Outcome encoding
    df['outcome'] = df['結果']
    df['red_win'] = df['outcome'] == '三紅'
    df['blue_win'] = df['outcome'].isin(['三藍死', '三藍活'])
    df['merlin_killed'] = df['outcome'] == '三藍死'

    return df


def load_chemistry_matrices(sh: gspread.Spreadsheet) -> dict[str, pd.DataFrame]:
    """Load co-occurrence matrices from sheets: 同贏, 同輸, 贏相關, 同贏-同輸."""
    matrices = {}
    for name in ['同贏', '同輸', '贏相關', '同贏-同輸']:
        ws = sh.worksheet(name)
        rows = ws.get_all_values()
        players = rows[0][1:]  # header row has player names
        data_rows = []
        row_names = []
        for row in rows[1:]:
            if not row[0]:
                continue
            row_names.append(row[0])
            vals = []
            for v in row[1:]:
                v_clean = v.replace('%', '').strip()
                try:
                    vals.append(float(v_clean))
                except (ValueError, TypeError):
                    vals.append(np.nan)
            data_rows.append(vals)
        mat_df = pd.DataFrame(data_rows, index=row_names, columns=players[:len(data_rows[0])])
        matrices[name] = mat_df
    return matrices


# =============================================================================
# 1. DATA LOADING & PARSING (Aggregate Stats)
# =============================================================================

def load_raw_data(path: Path) -> pd.DataFrame:
    """Parse the tab-separated raw stats file into a structured DataFrame."""

    # Read all lines
    lines = path.read_text(encoding='utf-8').splitlines()

    # Row 2 (index 1) is the header
    header_line = lines[1]
    headers_raw = header_line.split('\t')

    # Data rows start from row 3 (index 2)
    data_lines = lines[2:]

    # Build column names with disambiguation
    # The raw header has many duplicate names (e.g. multiple 刺/娜/德/奧/派/梅/忠)
    # We need to assign unique names based on position and context

    # Column mapping based on position analysis:
    # Col 0: row number (skip)
    # Col 1: player name
    # Col 2: total games (總場次)
    # Col 3: win rate (勝率)
    # Col 4: role theory (角色理論)
    # Col 5: position theory (位置理論)
    # Col 6: red 3-red (紅方三紅)
    # Col 7: red merlin dead (紅方梅死)
    # Col 8: red merlin alive (紅方梅活) -- actually 紅方梅活 is inverse
    # Col 9: (紅勝 or another metric)
    # Col 10: red win (紅勝)
    # Col 11: blue 3-red (藍方三紅)
    # Col 12: blue merlin dead (藍方梅死)
    # Col 13: blue merlin alive (藍方梅活)

    # From the header: player 總場次 勝率 角色理論 位置理論 紅方三紅 紅方梅死 紅方梅活 紅勝 藍方三紅 藍方梅死 藍方梅活
    # Then: 三藍 刺 娜 德 奧 派 梅 忠 (role win rates - 8 values)
    # Then: 刺 娜 德 奧 派 梅 忠 (role distribution % - 7 values)
    # Then: 紅角率 藍角率 (red/blue role rate)
    # Then: 1勝 2勝 ... 0勝 (seat win rates - 10 values)
    # Then: 雙尾派 1-5勝 6-0勝
    # Then: 1紅勝 ... 0紅勝 (seat red win - 10 values)
    # Then: 1藍勝 ... 0藍勝 (seat blue win - 10 values)
    # Then: 1紅 ... 0紅 (seat red % - 10 values)
    # Then: 1藍 ... 0藍 (seat blue % - 10 values)
    # Then raw counts: 三紅 三藍死 三藍活 三紅 三藍死 三藍活
    # Then: 刺 娜 德 奧 派 梅 忠 紅勝 藍勝 總勝
    # Then: 刺 娜 德 奧 派 梅 忠 紅場 藍場
    # Then seat raw counts...

    columns = [
        'player', 'total_games', 'win_rate', 'role_theory', 'position_theory',
        'red_3red', 'red_merlin_dead', 'red_merlin_alive', 'red_win',
        'blue_3red', 'blue_merlin_dead', 'blue_merlin_alive',
        # Role win rates (8 roles)
        'wr_三藍', 'wr_刺客', 'wr_莫甘娜', 'wr_莫德雷德', 'wr_奧伯倫', 'wr_派西維爾', 'wr_梅林', 'wr_忠臣',
        # Role distribution (7 roles)
        'dist_刺客', 'dist_莫甘娜', 'dist_莫德雷德', 'dist_奧伯倫', 'dist_派西維爾', 'dist_梅林', 'dist_忠臣',
        # Faction rate
        'red_role_rate', 'blue_role_rate',
        # Seat win rates (seats 1-9, 0)
        'seat1_wr', 'seat2_wr', 'seat3_wr', 'seat4_wr', 'seat5_wr',
        'seat6_wr', 'seat7_wr', 'seat8_wr', 'seat9_wr', 'seat0_wr',
        # Composite
        'dual_tail_percival', 'seat15_wr', 'seat60_wr',
        # Seat red win rates
        'seat1_red_wr', 'seat2_red_wr', 'seat3_red_wr', 'seat4_red_wr', 'seat5_red_wr',
        'seat6_red_wr', 'seat7_red_wr', 'seat8_red_wr', 'seat9_red_wr', 'seat0_red_wr',
        # Seat blue win rates
        'seat1_blue_wr', 'seat2_blue_wr', 'seat3_blue_wr', 'seat4_blue_wr', 'seat5_blue_wr',
        'seat6_blue_wr', 'seat7_blue_wr', 'seat8_blue_wr', 'seat9_blue_wr', 'seat0_blue_wr',
        # Seat red distribution
        'seat1_red_pct', 'seat2_red_pct', 'seat3_red_pct', 'seat4_red_pct', 'seat5_red_pct',
        'seat6_red_pct', 'seat7_red_pct', 'seat8_red_pct', 'seat9_red_pct', 'seat0_red_pct',
        # Seat blue distribution
        'seat1_blue_pct', 'seat2_blue_pct', 'seat3_blue_pct', 'seat4_blue_pct', 'seat5_blue_pct',
        'seat6_blue_pct', 'seat7_blue_pct', 'seat8_blue_pct', 'seat9_blue_pct', 'seat0_blue_pct',
        # Raw counts - mission outcomes
        'raw_red_3red', 'raw_red_3blue_dead', 'raw_red_3blue_alive',
        'raw_blue_3red', 'raw_blue_3blue_dead', 'raw_blue_3blue_alive',
        # Raw counts - role games
        'raw_刺客', 'raw_莫甘娜', 'raw_莫德雷德', 'raw_奧伯倫', 'raw_派西維爾', 'raw_梅林', 'raw_忠臣',
        # Raw counts - faction wins
        'raw_red_wins', 'raw_blue_wins', 'raw_total_wins',
        # Raw counts - role game counts (second set)
        'raw2_刺客', 'raw2_莫甘娜', 'raw2_莫德雷德', 'raw2_奧伯倫', 'raw2_派西維爾', 'raw2_梅林',
        # Raw faction game counts
        'raw_red_games', 'raw_blue_games',
        # Raw total games (verification)
        'raw_total_verify',
    ]

    # Seat-level raw counts (10 seats x 2 factions x 2 metrics = 40 columns)
    for prefix in ['seat_red_win', 'seat_blue_win', 'seat_red_count', 'seat_blue_count']:
        for seat in ['1','2','3','4','5','6','7','8','9','0']:
            columns.append(f'raw_{prefix}_{seat}')

    # Parse data rows
    records = []
    for line in data_lines:
        if not line.strip():
            continue
        fields = line.split('\t')
        # Pad to expected length
        while len(fields) < len(columns):
            fields.append('')
        # Truncate if too long
        fields = fields[:len(columns)]
        records.append(fields)

    df = pd.DataFrame(records, columns=columns)

    # Drop aggregate row (first row has empty player name)
    df = df[df['player'].str.strip().astype(bool)].copy()

    # Convert percentage columns
    pct_cols = [c for c in df.columns if c != 'player' and ('rate' in c or 'wr' in c or 'pct' in c or c.startswith('wr_') or c.startswith('dist_') or c.startswith('red_') or c.startswith('blue_'))]
    # Actually, let's be more precise - convert all non-player columns
    for col in df.columns:
        if col == 'player':
            continue
        df[col] = df[col].astype(str).str.replace('%', '').str.strip()
        df[col] = pd.to_numeric(df[col], errors='coerce')

    # Convert percentage values (those stored as e.g. "47.0" meaning 47%) to 0-1 scale where appropriate
    # Win rates and distributions are already in % form, keep as-is for readability

    return df


def filter_significant_players(df: pd.DataFrame, min_games: int = MIN_GAMES_THRESHOLD) -> pd.DataFrame:
    """Filter to players with enough games for statistical significance."""
    return df[df['total_games'] >= min_games].copy()


# =============================================================================
# 2. ANALYSIS FUNCTIONS
# =============================================================================

# --- Analysis 1: Lady of the Lake (湖中女神) ---

def analyze_lady_of_lake(game_df: pd.DataFrame) -> dict[str, Any]:
    """
    湖中女神 analysis: holder's faction/role impact on game outcome.

    Examines:
    - Win rate by holder faction (red/blue) for each lake use
    - Win rate by target faction (who gets checked)
    - Same-faction vs cross-faction check outcomes
    - Role-specific lake holder effectiveness
    """
    results: dict[str, Any] = {}

    for lake_num, lake_label in [(1, '首湖'), (2, '二湖'), (3, '三湖')]:
        holder_col = f'{lake_label}_holder_faction'
        target_col = f'{lake_label}_target_faction'

        subset = game_df[game_df[holder_col] != ''].copy()
        if len(subset) == 0:
            continue

        # Win rate by holder faction
        holder_stats = subset.groupby(holder_col).agg(
            total=('red_win', 'count'),
            red_wins=('red_win', 'sum'),
        ).reset_index()
        holder_stats['red_wr'] = holder_stats['red_wins'] / holder_stats['total'] * 100

        # Win rate by holder x target faction combination
        combo_stats = subset.groupby([holder_col, target_col]).agg(
            total=('red_win', 'count'),
            red_wins=('red_win', 'sum'),
            merlin_kills=('merlin_killed', 'sum'),
        ).reset_index()
        combo_stats['red_wr'] = combo_stats['red_wins'] / combo_stats['total'] * 100

        results[lake_label] = {
            'total_games': len(subset),
            'holder_stats': holder_stats,
            'combo_stats': combo_stats,
        }

    # Role-specific analysis for lake holder
    lake1_subset = game_df[game_df['首湖_holder_faction'] != ''].copy()
    if len(lake1_subset) > 0:
        role_stats = lake1_subset.groupby('首湖_holder_role').agg(
            total=('red_win', 'count'),
            red_wins=('red_win', 'sum'),
            blue_wins=('blue_win', 'sum'),
        ).reset_index()
        role_stats['red_wr'] = role_stats['red_wins'] / role_stats['total'] * 100
        role_stats['blue_wr'] = role_stats['blue_wins'] / role_stats['total'] * 100
        results['holder_role_stats'] = role_stats

    # Target role analysis: what role gets checked, and game outcome
    if len(lake1_subset) > 0:
        target_stats = lake1_subset.groupby('首湖_target_role').agg(
            total=('red_win', 'count'),
            red_wins=('red_win', 'sum'),
        ).reset_index()
        target_stats['red_wr'] = target_stats['red_wins'] / target_stats['total'] * 100
        results['target_role_stats'] = target_stats

    return results


# --- Analysis 2-4: Round 1-1 Voting ---

def analyze_round_11(game_df: pd.DataFrame) -> dict[str, Any]:
    """
    Round 1-1 analysis:
    - Vision vs non-vision voting differences (Merlin in team vs not)
    - Merlin's thumb position based on team composition
    - Mission 1 fail rate by team composition
    """
    results: dict[str, Any] = {}
    valid = game_df[game_df['r11_seats'].apply(len) > 0].copy()

    # --- 2a. Vision vs non-vision in 1-1 team ---
    # Games where Merlin is in the 1-1 team vs not
    merlin_in = valid[valid['r11_has_merlin']]
    merlin_out = valid[~valid['r11_has_merlin']]

    vision_stats = {
        'merlin_in_team': {
            'games': len(merlin_in),
            'mission1_pass_rate': (merlin_in['mission1_fails'] == 0).mean() * 100 if len(merlin_in) > 0 else 0,
            'red_wr': merlin_in['red_win'].mean() * 100 if len(merlin_in) > 0 else 0,
            'blue_wr': merlin_in['blue_win'].mean() * 100 if len(merlin_in) > 0 else 0,
        },
        'merlin_not_in_team': {
            'games': len(merlin_out),
            'mission1_pass_rate': (merlin_out['mission1_fails'] == 0).mean() * 100 if len(merlin_out) > 0 else 0,
            'red_wr': merlin_out['red_win'].mean() * 100 if len(merlin_out) > 0 else 0,
            'blue_wr': merlin_out['blue_win'].mean() * 100 if len(merlin_out) > 0 else 0,
        },
    }

    # Percival in team
    perc_in = valid[valid['r11_has_percival']]
    perc_out = valid[~valid['r11_has_percival']]
    vision_stats['percival_in_team'] = {
        'games': len(perc_in),
        'mission1_pass_rate': (perc_in['mission1_fails'] == 0).mean() * 100 if len(perc_in) > 0 else 0,
        'red_wr': perc_in['red_win'].mean() * 100 if len(perc_in) > 0 else 0,
    }
    vision_stats['percival_not_in_team'] = {
        'games': len(perc_out),
        'mission1_pass_rate': (perc_out['mission1_fails'] == 0).mean() * 100 if len(perc_out) > 0 else 0,
        'red_wr': perc_out['red_win'].mean() * 100 if len(perc_out) > 0 else 0,
    }

    results['vision_stats'] = vision_stats

    # --- 2b. Merlin thumb position ---
    # When Merlin is seat X and 1-1 team is chosen, does Merlin approve or reject?
    # We infer from 派5 (Percival picks seat 5) and overall team composition
    # More directly: analyze mission1 outcome based on red presence in team

    # Red count in 1-1 team vs mission1 outcome
    red_in_team_stats = valid.groupby('r11_red_count').agg(
        games=('red_win', 'count'),
        mission1_all_pass=('mission1_fails', lambda x: (x == 0).sum()),
        overall_red_wr=('red_win', 'mean'),
    ).reset_index()
    red_in_team_stats['mission1_pass_rate'] = red_in_team_stats['mission1_all_pass'] / red_in_team_stats['games'] * 100
    red_in_team_stats['overall_red_wr'] = red_in_team_stats['overall_red_wr'] * 100
    results['red_in_r11'] = red_in_team_stats

    # --- 2c. Merlin's voting pattern ---
    # Merlin approves/rejects based on whether evil is in the team
    # When evil in 1-1: Merlin should reject -> mission1 likely has fails
    # When no evil in 1-1: Merlin should approve -> mission1 all pass
    merlin_games = valid.copy()
    merlin_games['evil_in_r11'] = merlin_games['r11_red_count'] > 0
    merlin_games['mission1_clean'] = merlin_games['mission1_fails'] == 0

    merlin_thumb = merlin_games.groupby(['r11_has_merlin', 'evil_in_r11']).agg(
        games=('red_win', 'count'),
        mission1_clean_count=('mission1_clean', 'sum'),
        red_wr=('red_win', 'mean'),
    ).reset_index()
    merlin_thumb['mission1_clean_rate'] = merlin_thumb['mission1_clean_count'] / merlin_thumb['games'] * 100
    merlin_thumb['red_wr'] = merlin_thumb['red_wr'] * 100
    results['merlin_thumb'] = merlin_thumb

    return results


def analyze_round_12_branching(game_df: pd.DataFrame) -> dict[str, Any]:
    """
    Round 1-2 faction/role branching based on Round 1-1 results.

    When mission 1 passes (all o) vs fails (has x):
    - How does mission 2 composition change?
    - Red win rate by mission 1 outcome
    - Team size progression patterns
    """
    results: dict[str, Any] = {}
    valid = game_df[game_df['第一局成功失敗'].str.len() > 0].copy()
    valid['mission1_passed'] = valid['mission1_fails'] == 0

    # Overall branching by mission 1 result
    branch_stats = valid.groupby('mission1_passed').agg(
        games=('red_win', 'count'),
        red_wins=('red_win', 'sum'),
        merlin_kills=('merlin_killed', 'sum'),
    ).reset_index()
    branch_stats['red_wr'] = branch_stats['red_wins'] / branch_stats['games'] * 100
    branch_stats['merlin_kill_rate'] = branch_stats['merlin_kills'] / branch_stats['games'] * 100
    results['mission1_branch'] = branch_stats

    # Mission 2 outcome given mission 1 result
    has_m2 = valid[valid['第二局成功失敗'].str.len() > 0].copy()
    has_m2['mission2_passed'] = has_m2['mission2_fails'] == 0

    m1_to_m2 = has_m2.groupby(['mission1_passed', 'mission2_passed']).agg(
        games=('red_win', 'count'),
        red_wr=('red_win', 'mean'),
    ).reset_index()
    m1_to_m2['red_wr'] = m1_to_m2['red_wr'] * 100
    results['m1_to_m2_flow'] = m1_to_m2

    # Mission round (藍/紅) progression
    round_cols = ['第一局', '第二局', '第三局', '第四局', '第五局']
    round_progression = {}
    for col in round_cols:
        subset = valid[valid[col] != '']
        if len(subset) == 0:
            continue
        vc = subset[col].value_counts()
        total = vc.sum()
        round_progression[col] = {
            '藍_pct': vc.get('藍', 0) / total * 100,
            '紅_pct': vc.get('紅', 0) / total * 100,
            'total': total,
        }
    results['round_progression'] = round_progression

    # 局勢 (game state string) analysis
    valid_state = valid[valid['局勢'].str.len() > 0].copy()
    if len(valid_state) > 0:
        state_stats = valid_state.groupby('局勢').agg(
            games=('red_win', 'count'),
            red_wr=('red_win', 'mean'),
        ).reset_index()
        state_stats['red_wr'] = state_stats['red_wr'] * 100
        state_stats = state_stats.sort_values('games', ascending=False).head(20)
        results['game_states'] = state_stats

    return results


# --- Analysis 5: Outer-White / Inner-Black Rates ---
def analyze_appearance_vs_reality(df: pd.DataFrame) -> dict:
    """
    Per player/role: outer-white (表白) / inner-black (裏黑) rates.

    Derived from:
    - Red win rate when playing blue roles (inner-black as red pretending good)
    - Blue loss rate when appearing good (outer-white but losing)
    - Role-specific win/loss patterns indicating deception skill
    """
    players = filter_significant_players(df)

    results = {}
    for _, row in players.iterrows():
        name = row['player']
        # Red faction effectiveness (how well they deceive as evil)
        red_wr = row['red_win'] if pd.notna(row['red_win']) else 0
        # Blue faction win rate
        blue_total = row.get('raw_blue_games', 0)
        blue_wins = row.get('raw_blue_wins', 0)
        blue_wr = (blue_wins / blue_total * 100) if blue_total and blue_total > 0 else 0

        # Merlin alive rate (when red, how often Merlin survives = red player failed to identify)
        merlin_alive = row.get('red_merlin_alive', 0)
        merlin_dead = row.get('red_merlin_dead', 0)

        results[name] = {
            'total_games': row['total_games'],
            'overall_wr': row['win_rate'],
            'red_wr': red_wr,
            'blue_wr': blue_wr,
            'red_merlin_kill_rate': merlin_dead if pd.notna(merlin_dead) else 0,
            'blue_merlin_survive': row.get('blue_merlin_alive', 0) if pd.notna(row.get('blue_merlin_alive', 0)) else 0,
            'red_role_rate': row.get('red_role_rate', 0),
        }

    return results


# --- Analysis 6: Mission Voting vs Black/White Ball ---
def analyze_mission_voting(df: pd.DataFrame) -> dict:
    """
    Per player/role: mission vote patterns (approve/reject) vs actual ball played.
    Requires per-game data for full analysis; we use aggregate stats here.
    """
    players = filter_significant_players(df)

    results = {}
    for _, row in players.iterrows():
        name = row['player']
        roles = {}
        for role in ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣']:
            wr = row.get(f'wr_{role}', np.nan)
            dist = row.get(f'dist_{role}', np.nan)
            raw_games = row.get(f'raw_{role}', 0)
            roles[role] = {
                'win_rate': wr,
                'play_rate': dist,
                'games': raw_games,
            }
        results[name] = roles

    return results


# =============================================================================
# 3. VISUALIZATION FUNCTIONS
# =============================================================================

def plot_player_radar(df: pd.DataFrame, players: list = None, save: bool = True):
    """
    Player comparison radar charts.
    Dimensions: overall WR, red WR, blue WR, role theory, position theory,
                merlin kill rate (red), merlin protect rate (blue), seat consistency
    """
    data = filter_significant_players(df)
    if players:
        data = data[data['player'].isin(players)]

    if len(data) == 0:
        print("[WARN] No players match criteria for radar chart.")
        return

    # Take top 8 players by game count if not specified
    if players is None:
        data = data.nlargest(8, 'total_games')

    # Radar dimensions
    categories = [
        '勝率', '紅方勝率', '藍方保護梅林',
        '角色理論', '位置理論',
        '紅方殺梅率', '場次經驗'
    ]

    n_cats = len(categories)
    angles = np.linspace(0, 2 * np.pi, n_cats, endpoint=False).tolist()
    angles += angles[:1]  # close the polygon

    fig, ax = plt.subplots(figsize=(10, 10), subplot_kw=dict(polar=True))

    colors = plt.cm.Set2(np.linspace(0, 1, len(data)))

    for idx, (_, row) in enumerate(data.iterrows()):
        values = [
            row['win_rate'] if pd.notna(row['win_rate']) else 0,
            row['red_win'] if pd.notna(row['red_win']) else 0,
            row['blue_merlin_alive'] if pd.notna(row['blue_merlin_alive']) else 0,
            row['role_theory'] if pd.notna(row['role_theory']) else 0,
            row['position_theory'] if pd.notna(row['position_theory']) else 0,
            row['red_merlin_dead'] if pd.notna(row['red_merlin_dead']) else 0,
            min(row['total_games'] / 10, 100),  # normalize to 0-100
        ]
        values += values[:1]

        ax.plot(angles, values, 'o-', linewidth=2, label=row['player'], color=colors[idx])
        ax.fill(angles, values, alpha=0.1, color=colors[idx])

    ax.set_thetagrids(np.degrees(angles[:-1]), categories)
    ax.set_ylim(0, 100)
    ax.set_title('玩家能力雷達圖 (Player Radar Chart)', size=16, y=1.08)
    ax.legend(loc='upper right', bbox_to_anchor=(1.3, 1.1), fontsize=9)

    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'player_radar.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'player_radar.png'}")
    plt.close(fig)


def plot_seat_heatmap(df: pd.DataFrame, save: bool = True):
    """
    Seat position heatmaps: win rate by seat for each player.
    """
    data = filter_significant_players(df, min_games=100)
    data = data.nlargest(15, 'total_games')

    seat_cols = [f'seat{s}_wr' for s in ['1','2','3','4','5','6','7','8','9','0']]
    seat_labels = ['Seat 1', 'Seat 2', 'Seat 3', 'Seat 4', 'Seat 5',
                   'Seat 6', 'Seat 7', 'Seat 8', 'Seat 9', 'Seat 10']

    heatmap_data = data[seat_cols].values.astype(float)
    player_names = data['player'].values

    fig, ax = plt.subplots(figsize=(14, 8))
    im = ax.imshow(heatmap_data, cmap='RdYlGn', aspect='auto', vmin=20, vmax=70)

    ax.set_xticks(range(10))
    ax.set_xticklabels(seat_labels, fontsize=10)
    ax.set_yticks(range(len(player_names)))
    ax.set_yticklabels(player_names, fontsize=10)

    # Add value annotations
    for i in range(len(player_names)):
        for j in range(10):
            val = heatmap_data[i, j]
            if not np.isnan(val):
                text_color = 'white' if val < 35 or val > 60 else 'black'
                ax.text(j, i, f'{val:.0f}%', ha='center', va='center',
                       fontsize=8, color=text_color)

    plt.colorbar(im, label='Win Rate %')
    ax.set_title('座位勝率熱力圖 (Seat Position Win Rate Heatmap)', size=14)

    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'seat_heatmap.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'seat_heatmap.png'}")
    plt.close(fig)


def plot_seat_heatmap_red_blue(df: pd.DataFrame, save: bool = True):
    """
    Seat heatmap split by red/blue faction.
    """
    data = filter_significant_players(df, min_games=100)
    data = data.nlargest(12, 'total_games')

    fig, axes = plt.subplots(1, 2, figsize=(20, 8))

    for faction_idx, (faction, prefix) in enumerate([('紅方', 'red'), ('藍方', 'blue')]):
        ax = axes[faction_idx]
        seat_cols = [f'seat{s}_{prefix}_wr' for s in ['1','2','3','4','5','6','7','8','9','0']]
        heatmap_data = data[seat_cols].values.astype(float)
        player_names = data['player'].values

        im = ax.imshow(heatmap_data, cmap='RdYlGn', aspect='auto', vmin=10, vmax=90)
        ax.set_xticks(range(10))
        ax.set_xticklabels([f'Seat {i}' for i in range(1, 11)], fontsize=9)
        ax.set_yticks(range(len(player_names)))
        ax.set_yticklabels(player_names, fontsize=10)

        for i in range(len(player_names)):
            for j in range(10):
                val = heatmap_data[i, j]
                if not np.isnan(val):
                    text_color = 'white' if val < 25 or val > 75 else 'black'
                    ax.text(j, i, f'{val:.0f}%', ha='center', va='center',
                           fontsize=7, color=text_color)

        plt.colorbar(im, ax=ax, label='Win Rate %')
        ax.set_title(f'{faction}座位勝率 ({faction} Seat Win Rate)', size=12)

    plt.suptitle('紅藍陣營座位勝率熱力圖', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'seat_heatmap_red_blue.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'seat_heatmap_red_blue.png'}")
    plt.close(fig)


def plot_chemistry_matrix(df: pd.DataFrame, save: bool = True, matrices: dict[str, pd.DataFrame] | None = None):
    """
    Chemistry effect matrix using actual co-occurrence data from Google Sheets.

    Uses 同贏-同輸 (co-win minus co-loss) as the primary chemistry signal.
    Falls back to approximation if Sheets data unavailable.
    """
    if matrices and '同贏-同輸' in matrices:
        chem_df = matrices['同贏-同輸']
        players_list = list(chem_df.index)
        n = len(players_list)
        chemistry = chem_df.values.astype(float)

        fig, ax = plt.subplots(figsize=(14, 12))
        # Center colormap at 0 (negative = bad chemistry, positive = good)
        abs_max = max(abs(np.nanmin(chemistry)), abs(np.nanmax(chemistry)))
        im = ax.imshow(chemistry, cmap='RdBu', aspect='auto', vmin=-abs_max, vmax=abs_max)

        ax.set_xticks(range(n))
        ax.set_xticklabels(players_list, rotation=45, ha='right', fontsize=8)
        ax.set_yticks(range(n))
        ax.set_yticklabels(players_list, fontsize=8)

        for i in range(n):
            for j in range(n):
                val = chemistry[i][j]
                if np.isnan(val):
                    continue
                text_color = 'white' if abs(val) > abs_max * 0.6 else 'black'
                ax.text(j, i, f'{val:.0f}', ha='center', va='center', fontsize=6, color=text_color)

        plt.colorbar(im, label='Co-Win minus Co-Loss (%)')
        ax.set_title('玩家化學效應矩陣 (Player Chemistry Matrix)\n同贏-同輸: actual co-occurrence data', size=13)
    else:
        # Fallback: approximation from aggregate stats
        data = filter_significant_players(df, min_games=100)
        data = data.nlargest(12, 'total_games')
        players_list = data['player'].tolist()
        n = len(players_list)
        role_wr_cols = ['wr_刺客', 'wr_莫甘娜', 'wr_莫德雷德', 'wr_奧伯倫', 'wr_派西維爾', 'wr_梅林', 'wr_忠臣']
        chemistry = np.zeros((n, n))
        for i in range(n):
            for j in range(n):
                if i == j:
                    chemistry[i][j] = data.iloc[i]['win_rate']
                    continue
                p1 = np.where(np.isnan(data.iloc[i][role_wr_cols].values.astype(float)), 50, data.iloc[i][role_wr_cols].values.astype(float))
                p2 = np.where(np.isnan(data.iloc[j][role_wr_cols].values.astype(float)), 50, data.iloc[j][role_wr_cols].values.astype(float))
                chemistry[i][j] = np.mean((p1 + p2) / 2)

        fig, ax = plt.subplots(figsize=(12, 10))
        im = ax.imshow(chemistry, cmap='YlOrRd', aspect='auto', vmin=30, vmax=70)
        ax.set_xticks(range(n))
        ax.set_xticklabels(players_list, rotation=45, ha='right', fontsize=9)
        ax.set_yticks(range(n))
        ax.set_yticklabels(players_list, fontsize=9)
        for i in range(n):
            for j in range(n):
                val = chemistry[i][j]
                text_color = 'white' if val > 60 else 'black'
                ax.text(j, i, f'{val:.0f}', ha='center', va='center', fontsize=7, color=text_color)
        plt.colorbar(im, label='Chemistry Score')
        ax.set_title('玩家化學效應矩陣 (Approximation)', size=13)

    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'chemistry_matrix.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'chemistry_matrix.png'}")
    plt.close(fig)


def plot_role_aptitude(df: pd.DataFrame, save: bool = True):
    """
    Role aptitude rankings - who is best at each role.
    """
    data = filter_significant_players(df, min_games=100)

    roles = {
        '刺客 (Assassin)': ('wr_刺客', 'raw_刺客'),
        '莫甘娜 (Morgana)': ('wr_莫甘娜', 'raw_莫甘娜'),
        '莫德雷德 (Mordred)': ('wr_莫德雷德', 'raw_莫德雷德'),
        '奧伯倫 (Oberon)': ('wr_奧伯倫', 'raw_奧伯倫'),
        '派西維爾 (Percival)': ('wr_派西維爾', 'raw_派西維爾'),
        '梅林 (Merlin)': ('wr_梅林', 'raw_梅林'),
        '忠臣 (Loyal)': ('wr_忠臣', 'raw_忠臣'),
    }

    fig, axes = plt.subplots(2, 4, figsize=(20, 10))
    axes = axes.flatten()

    for idx, (role_name, (wr_col, raw_col)) in enumerate(roles.items()):
        ax = axes[idx]

        # Filter players with at least 10 games in this role
        role_data = data[data[raw_col] >= 10].copy()
        role_data = role_data.sort_values(wr_col, ascending=True).tail(12)

        if len(role_data) == 0:
            ax.set_title(role_name)
            ax.text(0.5, 0.5, 'Insufficient data', ha='center', va='center')
            continue

        colors_map = plt.cm.RdYlGn(role_data[wr_col].values / 100)
        bars = ax.barh(range(len(role_data)), role_data[wr_col].values, color=colors_map)
        ax.set_yticks(range(len(role_data)))
        ax.set_yticklabels(role_data['player'].values, fontsize=8)
        ax.set_xlim(0, 100)
        ax.set_title(role_name, fontsize=11)
        ax.set_xlabel('Win Rate %')

        # Add value labels
        for bar_idx, (bar, val) in enumerate(zip(bars, role_data[wr_col].values)):
            if not np.isnan(val):
                ax.text(val + 1, bar_idx, f'{val:.0f}%', va='center', fontsize=7)

    # Hide the 8th subplot (we have 7 roles)
    axes[7].set_visible(False)

    plt.suptitle('角色勝率排名 (Role Aptitude Rankings)', size=16, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'role_aptitude.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'role_aptitude.png'}")
    plt.close(fig)


def plot_role_distribution_comparison(df: pd.DataFrame, save: bool = True):
    """
    Stacked bar: role distribution per player.
    """
    data = filter_significant_players(df, min_games=200)
    data = data.nlargest(15, 'total_games')

    role_cols = ['dist_刺客', 'dist_莫甘娜', 'dist_莫德雷德', 'dist_奧伯倫', 'dist_派西維爾', 'dist_梅林', 'dist_忠臣']
    role_labels = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣']

    fig, ax = plt.subplots(figsize=(14, 7))

    bottom = np.zeros(len(data))
    colors_role = ['#e74c3c', '#9b59b6', '#2c3e50', '#7f8c8d', '#3498db', '#2ecc71', '#f39c12']

    for i, (col, label, color) in enumerate(zip(role_cols, role_labels, colors_role)):
        values = data[col].fillna(0).values
        ax.bar(range(len(data)), values, bottom=bottom, label=label, color=color, alpha=0.85)
        bottom += values

    ax.set_xticks(range(len(data)))
    ax.set_xticklabels(data['player'].values, rotation=45, ha='right', fontsize=10)
    ax.set_ylabel('Distribution %')
    ax.set_title('玩家角色分配比例 (Role Distribution per Player)', size=14)
    ax.legend(loc='upper right', fontsize=9)

    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'role_distribution.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'role_distribution.png'}")
    plt.close(fig)


def plot_win_rate_trend(df: pd.DataFrame, save: bool = True):
    """
    Win rate by game count brackets - trend over experience.
    Shows how players improve (or not) with more games.
    """
    data = filter_significant_players(df, min_games=50)

    # Create experience tiers
    bins = [0, 100, 200, 400, 600, 1000]
    labels = ['<100', '100-200', '200-400', '400-600', '600+']
    data['exp_tier'] = pd.cut(data['total_games'], bins=bins, labels=labels, right=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # Left: Box plot of win rates by experience tier
    ax = axes[0]
    tier_data = []
    tier_labels_used = []
    for tier in labels:
        tier_players = data[data['exp_tier'] == tier]['win_rate'].dropna()
        if len(tier_players) > 0:
            tier_data.append(tier_players.values)
            tier_labels_used.append(tier)

    bp = ax.boxplot(tier_data, labels=tier_labels_used, patch_artist=True)
    colors_tier = plt.cm.viridis(np.linspace(0.2, 0.8, len(tier_data)))
    for patch, color in zip(bp['boxes'], colors_tier):
        patch.set_facecolor(color)
        patch.set_alpha(0.7)

    ax.set_xlabel('Games Played')
    ax.set_ylabel('Win Rate %')
    ax.set_title('經驗與勝率關係 (Experience vs Win Rate)')
    ax.axhline(y=50, color='red', linestyle='--', alpha=0.5, label='50% baseline')
    ax.legend()

    # Right: Scatter plot of total games vs win rate
    ax2 = axes[1]
    scatter = ax2.scatter(data['total_games'], data['win_rate'],
                         c=data['win_rate'], cmap='RdYlGn',
                         s=50, alpha=0.7, edgecolors='black', linewidths=0.5)

    # Label top players
    top_players = data.nlargest(10, 'total_games')
    for _, row in top_players.iterrows():
        ax2.annotate(row['player'], (row['total_games'], row['win_rate']),
                    fontsize=7, ha='left', va='bottom', alpha=0.8)

    ax2.set_xlabel('Total Games')
    ax2.set_ylabel('Win Rate %')
    ax2.set_title('場次 vs 勝率分布 (Games vs Win Rate)')
    ax2.axhline(y=50, color='red', linestyle='--', alpha=0.5)
    plt.colorbar(scatter, ax=ax2, label='Win Rate %')

    plt.suptitle('經驗趨勢分析 (Experience Trend Analysis)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'win_rate_trend.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'win_rate_trend.png'}")
    plt.close(fig)


def plot_faction_performance(df: pd.DataFrame, save: bool = True):
    """
    Red vs Blue faction performance comparison per player.
    Includes merlin kill/protect rates.
    """
    data = filter_significant_players(df, min_games=200)
    data = data.nlargest(15, 'total_games')

    fig, axes = plt.subplots(1, 3, figsize=(20, 7))

    # Panel 1: Red win rate
    ax = axes[0]
    sorted_data = data.sort_values('red_win', ascending=True)
    colors_red = plt.cm.Reds(sorted_data['red_win'].values / 100 * 0.8 + 0.2)
    ax.barh(range(len(sorted_data)), sorted_data['red_win'].values, color=colors_red)
    ax.set_yticks(range(len(sorted_data)))
    ax.set_yticklabels(sorted_data['player'].values, fontsize=9)
    ax.set_xlabel('Win Rate %')
    ax.set_title('紅方勝率 (Red Win Rate)')
    ax.axvline(x=50, color='black', linestyle='--', alpha=0.3)

    # Panel 2: Blue performance (using overall - red as proxy)
    ax2 = axes[1]
    # Calculate blue win rate from raw data
    blue_wrs = []
    for _, row in data.iterrows():
        if row['raw_blue_games'] > 0:
            blue_wr = row['raw_blue_wins'] / row['raw_blue_games'] * 100
        else:
            blue_wr = 0
        blue_wrs.append(blue_wr)
    data = data.copy()
    data['calc_blue_wr'] = blue_wrs

    sorted_data2 = data.sort_values('calc_blue_wr', ascending=True)
    colors_blue = plt.cm.Blues(sorted_data2['calc_blue_wr'].values / 100 * 0.8 + 0.2)
    ax2.barh(range(len(sorted_data2)), sorted_data2['calc_blue_wr'].values, color=colors_blue)
    ax2.set_yticks(range(len(sorted_data2)))
    ax2.set_yticklabels(sorted_data2['player'].values, fontsize=9)
    ax2.set_xlabel('Win Rate %')
    ax2.set_title('藍方勝率 (Blue Win Rate)')
    ax2.axvline(x=50, color='black', linestyle='--', alpha=0.3)

    # Panel 3: Merlin dynamics
    ax3 = axes[2]
    x = np.arange(len(data))
    width = 0.35
    sorted_data3 = data.sort_values('red_merlin_dead', ascending=True)
    ax3.barh(x - width/2, sorted_data3['red_merlin_dead'].fillna(0).values, width,
            label='紅方殺梅率 (Merlin Kill)', color='#e74c3c', alpha=0.7)
    ax3.barh(x + width/2, sorted_data3['blue_merlin_alive'].fillna(0).values, width,
            label='藍方保梅率 (Merlin Protect)', color='#3498db', alpha=0.7)
    ax3.set_yticks(x)
    ax3.set_yticklabels(sorted_data3['player'].values, fontsize=9)
    ax3.set_xlabel('%')
    ax3.set_title('梅林生死影響 (Merlin Kill/Protect)')
    ax3.legend(fontsize=8)

    plt.suptitle('陣營表現分析 (Faction Performance)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'faction_performance.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'faction_performance.png'}")
    plt.close(fig)


def plot_three_red_analysis(df: pd.DataFrame, save: bool = True):
    """
    三紅 (3-red mission) analysis - one of the most critical game states.
    """
    data = filter_significant_players(df, min_games=100)
    data = data.nlargest(15, 'total_games')

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Left: Red side 3-red rate
    ax = axes[0]
    sorted_data = data.sort_values('red_3red', ascending=True)
    ax.barh(range(len(sorted_data)), sorted_data['red_3red'].fillna(0).values,
           color='#e74c3c', alpha=0.7, label='紅方三紅')
    ax.barh(range(len(sorted_data)), sorted_data['blue_3red'].fillna(0).values,
           color='#3498db', alpha=0.5, label='藍方三紅')
    ax.set_yticks(range(len(sorted_data)))
    ax.set_yticklabels(sorted_data['player'].values, fontsize=9)
    ax.set_xlabel('Rate %')
    ax.set_title('三紅發生率 (3-Red Rate by Faction)')
    ax.legend()

    # Right: 3-red outcome (win rate when 3-red happens)
    ax2 = axes[1]
    sorted_data2 = data.sort_values('wr_三藍', ascending=True)
    colors_3blue = plt.cm.RdYlGn(sorted_data2['wr_三藍'].values / 100)
    ax2.barh(range(len(sorted_data2)), sorted_data2['wr_三藍'].fillna(0).values,
            color=colors_3blue, alpha=0.8)
    ax2.set_yticks(range(len(sorted_data2)))
    ax2.set_yticklabels(sorted_data2['player'].values, fontsize=9)
    ax2.set_xlabel('Win Rate %')
    ax2.set_title('三藍勝率 (3-Blue Win Rate)')
    ax2.axvline(x=50, color='black', linestyle='--', alpha=0.3)

    plt.suptitle('三紅局勢分析 (3-Red Game State Analysis)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'three_red_analysis.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'three_red_analysis.png'}")
    plt.close(fig)


# =============================================================================
# 3b. PER-GAME VISUALIZATION FUNCTIONS
# =============================================================================

def plot_lady_of_lake(lake_results: dict[str, Any], save: bool = True):
    """Visualize Lady of the Lake analysis results."""
    if not lake_results:
        print("[WARN] No Lady of the Lake data to plot.")
        return

    fig, axes = plt.subplots(2, 3, figsize=(18, 12))

    # Top row: faction combo analysis per lake
    for idx, lake_label in enumerate(['首湖', '二湖', '三湖']):
        ax = axes[0][idx]
        if lake_label not in lake_results:
            ax.text(0.5, 0.5, 'No data', ha='center', va='center', transform=ax.transAxes)
            ax.set_title(f'{lake_label} (Lady #{idx+1})')
            continue

        stats = lake_results[lake_label]
        combo = stats['combo_stats']

        labels = []
        values = []
        colors_list = []
        game_counts = []
        for _, row in combo.iterrows():
            label = f"{row.iloc[0]}>{row.iloc[1]}"
            labels.append(label)
            values.append(row['red_wr'])
            game_counts.append(int(row['total']))
            if row.iloc[0] == '紅方':
                colors_list.append('#e74c3c' if row.iloc[1] == '紅方' else '#e67e22')
            else:
                colors_list.append('#3498db' if row.iloc[1] == '藍方' else '#2980b9')

        bars = ax.bar(range(len(labels)), values, color=colors_list, alpha=0.8)
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, fontsize=9, rotation=30)
        ax.set_ylabel('Red Win Rate %')
        ax.set_title(f'{lake_label} (n={stats["total_games"]})')
        ax.axhline(y=50, color='gray', linestyle='--', alpha=0.5)

        for bar, val, n in zip(bars, values, game_counts):
            ax.text(bar.get_x() + bar.get_width()/2, val + 1, f'{val:.0f}%\n(n={n})',
                   ha='center', fontsize=7)

    # Bottom left: holder role stats
    ax_hr = axes[1][0]
    if 'holder_role_stats' in lake_results:
        hr = lake_results['holder_role_stats']
        hr_sorted = hr.sort_values('red_wr', ascending=True)
        role_colors = {'刺客':'#e74c3c', '莫甘娜':'#9b59b6', '莫德雷德':'#2c3e50', '奧伯倫':'#7f8c8d',
                      '派西維爾':'#3498db', '梅林':'#2ecc71', '忠臣':'#f39c12'}
        colors_hr = [role_colors.get(r, '#95a5a6') for r in hr_sorted['首湖_holder_role']]
        ax_hr.barh(range(len(hr_sorted)), hr_sorted['red_wr'].values, color=colors_hr, alpha=0.8)
        ax_hr.set_yticks(range(len(hr_sorted)))
        ax_hr.set_yticklabels(hr_sorted['首湖_holder_role'].values, fontsize=9)
        ax_hr.set_xlabel('Red Win Rate %')
        ax_hr.set_title('Lake 1 Holder Role -> Red WR')
        ax_hr.axvline(x=50, color='gray', linestyle='--', alpha=0.5)
        for i, (_, row) in enumerate(hr_sorted.iterrows()):
            ax_hr.text(row['red_wr'] + 1, i, f'{row["red_wr"]:.0f}% (n={int(row["total"])})',
                      va='center', fontsize=7)

    # Bottom middle: target role stats
    ax_tr = axes[1][1]
    if 'target_role_stats' in lake_results:
        tr = lake_results['target_role_stats']
        tr_sorted = tr.sort_values('red_wr', ascending=True)
        colors_tr = [role_colors.get(r, '#95a5a6') for r in tr_sorted['首湖_target_role']]
        ax_tr.barh(range(len(tr_sorted)), tr_sorted['red_wr'].values, color=colors_tr, alpha=0.8)
        ax_tr.set_yticks(range(len(tr_sorted)))
        ax_tr.set_yticklabels(tr_sorted['首湖_target_role'].values, fontsize=9)
        ax_tr.set_xlabel('Red Win Rate %')
        ax_tr.set_title('Lake 1 Target Role -> Red WR')
        ax_tr.axvline(x=50, color='gray', linestyle='--', alpha=0.5)
        for i, (_, row) in enumerate(tr_sorted.iterrows()):
            ax_tr.text(row['red_wr'] + 1, i, f'{row["red_wr"]:.0f}% (n={int(row["total"])})',
                      va='center', fontsize=7)

    # Bottom right: lake progression (red WR by lake number)
    ax_prog = axes[1][2]
    lake_labels_prog = []
    lake_red_wrs = []
    lake_ns = []
    for lake_label in ['首湖', '二湖', '三湖']:
        if lake_label in lake_results:
            stats = lake_results[lake_label]
            overall_red_wr = stats['combo_stats']['red_wins'].sum() / stats['combo_stats']['total'].sum() * 100
            lake_labels_prog.append(lake_label)
            lake_red_wrs.append(overall_red_wr)
            lake_ns.append(stats['total_games'])

    colors_prog = ['#e74c3c' if wr > 50 else '#3498db' for wr in lake_red_wrs]
    bars_prog = ax_prog.bar(range(len(lake_labels_prog)), lake_red_wrs, color=colors_prog, alpha=0.8)
    ax_prog.set_xticks(range(len(lake_labels_prog)))
    ax_prog.set_xticklabels(lake_labels_prog, fontsize=10)
    ax_prog.set_ylabel('Red Win Rate %')
    ax_prog.set_title('Lake Progression: Red WR Trend')
    ax_prog.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
    for bar, val, n in zip(bars_prog, lake_red_wrs, lake_ns):
        ax_prog.text(bar.get_x() + bar.get_width()/2, val + 1, f'{val:.0f}%\n(n={n})',
                    ha='center', fontsize=9)

    plt.suptitle('湖中女神分析 (Lady of the Lake Analysis)\n持有者/查驗對象陣營角色 vs 紅方勝率', size=13, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'lady_of_lake.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'lady_of_lake.png'}")
    plt.close(fig)


def plot_round_11_analysis(r11_results: dict[str, Any], save: bool = True):
    """Visualize Round 1-1 analysis results."""
    if not r11_results:
        return

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Panel 1: Vision vs non-vision
    ax = axes[0][0]
    vs = r11_results['vision_stats']
    categories = ['Merlin in\nteam', 'Merlin not\nin team', 'Percival in\nteam', 'Percival not\nin team']
    keys = ['merlin_in_team', 'merlin_not_in_team', 'percival_in_team', 'percival_not_in_team']
    m1_pass = [vs[k]['mission1_pass_rate'] for k in keys]
    game_counts = [vs[k]['games'] for k in keys]

    bar_colors = ['#2ecc71', '#e74c3c', '#3498db', '#e67e22']
    bars = ax.bar(range(len(categories)), m1_pass, color=bar_colors, alpha=0.8)
    ax.set_xticks(range(len(categories)))
    ax.set_xticklabels(categories, fontsize=9)
    ax.set_ylabel('Mission 1 Pass Rate %')
    ax.set_title('Vision vs Non-Vision: Mission 1 Pass Rate')
    for bar, val, n in zip(bars, m1_pass, game_counts):
        ax.text(bar.get_x() + bar.get_width()/2, val + 1, f'{val:.1f}%\n(n={n})',
               ha='center', fontsize=8)

    # Panel 2: Red count in 1-1 team
    ax2 = axes[0][1]
    red_stats = r11_results['red_in_r11']
    x_vals = red_stats['r11_red_count'].values
    ax2.bar(x_vals - 0.2, red_stats['mission1_pass_rate'].values, 0.4,
           label='M1 Pass Rate', color='#2ecc71', alpha=0.8)
    ax2.bar(x_vals + 0.2, red_stats['overall_red_wr'].values, 0.4,
           label='Overall Red WR', color='#e74c3c', alpha=0.8)
    ax2.set_xticks(x_vals)
    ax2.set_xticklabels([f'{int(v)} red' for v in x_vals])
    ax2.set_ylabel('%')
    ax2.set_title('Red Count in 1-1 Team: Impact')
    ax2.legend(fontsize=8)

    for i, row in red_stats.iterrows():
        ax2.text(row['r11_red_count'] - 0.2, row['mission1_pass_rate'] + 1,
                f'n={int(row["games"])}', ha='center', fontsize=7)

    # Panel 3: Merlin thumb analysis
    ax3 = axes[1][0]
    mt = r11_results['merlin_thumb']
    # Group by merlin_in_team and evil_in_r11
    groups = []
    vals = []
    bar_colors2 = []
    for _, row in mt.iterrows():
        merlin_label = 'Merlin In' if row['r11_has_merlin'] else 'Merlin Out'
        evil_label = 'Evil In' if row['evil_in_r11'] else 'No Evil'
        groups.append(f'{merlin_label}\n{evil_label}')
        vals.append(row['mission1_clean_rate'])
        bar_colors2.append('#2ecc71' if not row['evil_in_r11'] else '#e74c3c')

    bars3 = ax3.bar(range(len(groups)), vals, color=bar_colors2, alpha=0.8)
    ax3.set_xticks(range(len(groups)))
    ax3.set_xticklabels(groups, fontsize=8)
    ax3.set_ylabel('Mission 1 Clean Rate %')
    ax3.set_title("Merlin's Thumb: Team Composition Effect")
    for bar, val, row_data in zip(bars3, vals, mt.itertuples()):
        ax3.text(bar.get_x() + bar.get_width()/2, val + 1,
                f'{val:.0f}%\n(n={int(row_data.games)})', ha='center', fontsize=7)

    # Panel 4: Red win rate by Merlin position
    ax4 = axes[1][1]
    red_wrs = []
    for _, row in mt.iterrows():
        red_wrs.append(row['red_wr'])
    bars4 = ax4.bar(range(len(groups)), red_wrs, color=['#c0392b']*len(groups), alpha=0.7)
    ax4.set_xticks(range(len(groups)))
    ax4.set_xticklabels(groups, fontsize=8)
    ax4.set_ylabel('Red Win Rate %')
    ax4.set_title('Red Win Rate by Merlin/Evil Presence in 1-1')
    ax4.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
    for bar, val in zip(bars4, red_wrs):
        ax4.text(bar.get_x() + bar.get_width()/2, val + 1, f'{val:.1f}%',
               ha='center', fontsize=8)

    plt.suptitle('Round 1-1 分析 (Round 1-1 Analysis)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'round_11_analysis.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'round_11_analysis.png'}")
    plt.close(fig)


def plot_round_12_branching(r12_results: dict[str, Any], save: bool = True):
    """Visualize Round 1-2 branching analysis."""
    if not r12_results:
        return

    fig, axes = plt.subplots(1, 3, figsize=(18, 6))

    # Panel 1: Mission 1 outcome -> overall result
    ax = axes[0]
    branch = r12_results['mission1_branch']
    labels = ['M1 Pass\n(all o)' if v else 'M1 Fail\n(has x)' for v in branch['mission1_passed']]
    x = range(len(labels))
    ax.bar([xi - 0.2 for xi in x], branch['red_wr'].values, 0.4,
          label='Red Win Rate', color='#e74c3c', alpha=0.8)
    ax.bar([xi + 0.2 for xi in x], branch['merlin_kill_rate'].values, 0.4,
          label='Merlin Kill Rate', color='#8e44ad', alpha=0.8)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel('%')
    ax.set_title('Mission 1 Result -> Game Outcome')
    ax.legend(fontsize=8)
    for i, (_, row) in enumerate(branch.iterrows()):
        ax.text(i - 0.2, row['red_wr'] + 1, f'{row["red_wr"]:.0f}%', ha='center', fontsize=8)
        ax.text(i + 0.2, row['merlin_kill_rate'] + 1, f'{row["merlin_kill_rate"]:.0f}%', ha='center', fontsize=8)

    # Panel 2: Mission 1 -> Mission 2 flow
    ax2 = axes[1]
    flow = r12_results.get('m1_to_m2_flow')
    if flow is not None and len(flow) > 0:
        groups = []
        red_wrs = []
        game_ns = []
        bar_colors_flow = []
        for _, row in flow.iterrows():
            m1 = 'M1 Pass' if row['mission1_passed'] else 'M1 Fail'
            m2 = 'M2 Pass' if row['mission2_passed'] else 'M2 Fail'
            groups.append(f'{m1}\n{m2}')
            red_wrs.append(row['red_wr'])
            game_ns.append(int(row['games']))
            if row['mission1_passed'] and row['mission2_passed']:
                bar_colors_flow.append('#27ae60')
            elif not row['mission1_passed'] and not row['mission2_passed']:
                bar_colors_flow.append('#c0392b')
            else:
                bar_colors_flow.append('#f39c12')

        bars2 = ax2.bar(range(len(groups)), red_wrs, color=bar_colors_flow, alpha=0.8)
        ax2.set_xticks(range(len(groups)))
        ax2.set_xticklabels(groups, fontsize=8)
        ax2.set_ylabel('Red Win Rate %')
        ax2.set_title('M1 -> M2 Transition: Red Win Rate')
        ax2.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
        for bar, val, n in zip(bars2, red_wrs, game_ns):
            ax2.text(bar.get_x() + bar.get_width()/2, val + 1, f'{val:.0f}%\n(n={n})',
                   ha='center', fontsize=7)
    else:
        ax2.text(0.5, 0.5, 'No M1->M2 data', ha='center', va='center', transform=ax2.transAxes)

    # Panel 3: Round progression (blue/red per mission)
    ax3 = axes[2]
    prog = r12_results.get('round_progression', {})
    if prog:
        round_labels = list(prog.keys())
        blue_pcts = [prog[r]['藍_pct'] for r in round_labels]
        red_pcts = [prog[r]['紅_pct'] for r in round_labels]
        totals = [prog[r]['total'] for r in round_labels]

        x3 = range(len(round_labels))
        ax3.bar(x3, blue_pcts, label='藍 (Blue win)', color='#3498db', alpha=0.8)
        ax3.bar(x3, red_pcts, bottom=blue_pcts, label='紅 (Red win)', color='#e74c3c', alpha=0.8)
        ax3.set_xticks(x3)
        ax3.set_xticklabels([r.replace('第', 'M').replace('局', '') for r in round_labels], fontsize=9)
        ax3.set_ylabel('Percentage %')
        ax3.set_title('Mission Outcome Progression')
        ax3.legend(fontsize=8)
        for i, (b, r, t) in enumerate(zip(blue_pcts, red_pcts, totals)):
            ax3.text(i, 50, f'n={t}', ha='center', fontsize=7, color='white')

    plt.suptitle('Round 1-2 分岐分析 (Mission Branching Analysis)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'round_12_branching.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'round_12_branching.png'}")
    plt.close(fig)


def plot_chemistry_detailed(matrices: dict[str, pd.DataFrame], save: bool = True):
    """
    Detailed chemistry visualization using multiple co-occurrence matrices.
    Produces a 2x2 grid: co-win counts, co-loss counts, win correlation, and net chemistry.
    """
    fig, axes = plt.subplots(2, 2, figsize=(20, 18))

    titles = {
        '同贏': ('Co-Win Counts (同贏)', 'YlGn'),
        '同輸': ('Co-Loss Counts (同輸)', 'YlOrRd'),
        '贏相關': ('Win Correlation % (贏相關)', 'RdYlGn'),
        '同贏-同輸': ('Net Chemistry: Co-Win minus Co-Loss (同贏-��輸)', 'RdBu'),
    }

    for idx, (name, (title, cmap)) in enumerate(titles.items()):
        ax = axes[idx // 2][idx % 2]
        if name not in matrices:
            ax.text(0.5, 0.5, f'No {name} data', ha='center', va='center', transform=ax.transAxes)
            continue

        mat = matrices[name]
        data_vals = mat.values.astype(float)
        players = list(mat.index)
        n = len(players)

        if name == '同贏-同輸':
            abs_max = max(abs(np.nanmin(data_vals)), abs(np.nanmax(data_vals)), 1)
            im = ax.imshow(data_vals, cmap=cmap, aspect='auto', vmin=-abs_max, vmax=abs_max)
        elif name == '贏相關':
            im = ax.imshow(data_vals, cmap=cmap, aspect='auto', vmin=0, vmax=100)
        else:
            im = ax.imshow(data_vals, cmap=cmap, aspect='auto')

        ax.set_xticks(range(n))
        ax.set_xticklabels(players, rotation=45, ha='right', fontsize=7)
        ax.set_yticks(range(n))
        ax.set_yticklabels(players, fontsize=7)
        ax.set_title(title, fontsize=11)
        plt.colorbar(im, ax=ax, shrink=0.8)

    plt.suptitle('玩家化學效應詳細分析 (Detailed Chemistry Analysis)', size=14, y=1.01)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'chemistry_detailed.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'chemistry_detailed.png'}")
    plt.close(fig)


def plot_mission_vote_analysis(game_df: pd.DataFrame, save: bool = True):
    """
    Mission vote vs black/white ball correlation.

    Analyzes the relationship between team voting patterns (o=approve, x=reject)
    and actual mission success/failure (black ball = fail).
    """
    valid = game_df[game_df['第一局成功失敗'].str.len() > 0].copy()

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Panel 1: Mission fail count distribution by outcome
    ax = axes[0][0]
    for i in range(1, 6):
        col = f'mission{i}_fails'
        subset = valid[valid[col].notna() & (valid[f'mission{i}_total'] > 0)]
        if len(subset) == 0:
            continue
        fail_dist = subset[col].value_counts().sort_index()
        ax.plot(fail_dist.index, fail_dist.values / len(subset) * 100,
               marker='o', label=f'Mission {i}', alpha=0.8)

    ax.set_xlabel('Number of Fail Votes (x)')
    ax.set_ylabel('Frequency %')
    ax.set_title('Fail Vote Distribution per Mission')
    ax.legend(fontsize=8)

    # Panel 2: Mission fail count vs game outcome
    ax2 = axes[0][1]
    # Total fails across all missions
    fail_cols = [f'mission{i}_fails' for i in range(1, 6)]
    valid['total_fails'] = valid[fail_cols].sum(axis=1)
    fail_bins = valid.groupby('total_fails').agg(
        games=('red_win', 'count'),
        red_wr=('red_win', 'mean'),
    ).reset_index()
    fail_bins = fail_bins[fail_bins['games'] >= 5]
    fail_bins['red_wr'] = fail_bins['red_wr'] * 100

    ax2.bar(fail_bins['total_fails'], fail_bins['red_wr'], color='#e74c3c', alpha=0.7)
    ax2.set_xlabel('Total Fail Votes Across All Missions')
    ax2.set_ylabel('Red Win Rate %')
    ax2.set_title('Total Fail Votes vs Red Win Rate')
    ax2.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
    for _, row in fail_bins.iterrows():
        ax2.text(row['total_fails'], row['red_wr'] + 1, f'n={int(row["games"])}',
                ha='center', fontsize=7)

    # Panel 3: Mission 1 specific analysis
    ax3 = axes[1][0]
    m1_data = valid[valid['mission1_total'] > 0].copy()
    m1_by_team_size = m1_data.groupby('mission1_total').agg(
        games=('red_win', 'count'),
        avg_fails=('mission1_fails', 'mean'),
        red_wr=('red_win', 'mean'),
    ).reset_index()
    m1_by_team_size['red_wr'] = m1_by_team_size['red_wr'] * 100

    x_ts = range(len(m1_by_team_size))
    ax3.bar(x_ts, m1_by_team_size['avg_fails'].values, color='#8e44ad', alpha=0.7)
    ax3.set_xticks(x_ts)
    ax3.set_xticklabels([f'{int(v)} votes' for v in m1_by_team_size['mission1_total']])
    ax3.set_ylabel('Average Fail Votes')
    ax3.set_title('Mission 1: Team Size vs Average Fails')
    for i, row in m1_by_team_size.iterrows():
        ax3.text(list(x_ts)[list(m1_by_team_size.index).index(i)],
                row['avg_fails'] + 0.02, f'n={int(row["games"])}', ha='center', fontsize=7)

    # Panel 4: Outcome by mission pattern (局勢)
    ax4 = axes[1][1]
    state_data = valid[valid['局勢'].str.len() > 0].copy()
    if len(state_data) > 0:
        top_states = state_data['局勢'].value_counts().head(10)
        state_names = top_states.index.tolist()
        state_red_wr = []
        state_counts = []
        for state in state_names:
            subset = state_data[state_data['局勢'] == state]
            state_red_wr.append(subset['red_win'].mean() * 100)
            state_counts.append(len(subset))

        colors_state = ['#e74c3c' if wr > 50 else '#3498db' for wr in state_red_wr]
        bars4 = ax4.barh(range(len(state_names)), state_red_wr, color=colors_state, alpha=0.8)
        ax4.set_yticks(range(len(state_names)))
        ax4.set_yticklabels(state_names, fontsize=8)
        ax4.set_xlabel('Red Win Rate %')
        ax4.set_title('Top 10 Game States: Red Win Rate')
        ax4.axvline(x=50, color='gray', linestyle='--', alpha=0.5)
        for i, (val, n) in enumerate(zip(state_red_wr, state_counts)):
            ax4.text(val + 1, i, f'{val:.0f}% (n={n})', va='center', fontsize=7)

    plt.suptitle('任務投票與黑白球分析 (Mission Vote & Ball Analysis)', size=14, y=1.02)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'mission_vote_analysis.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'mission_vote_analysis.png'}")
    plt.close(fig)


def plot_game_state_heatmap(game_df: pd.DataFrame, save: bool = True):
    """
    Game state (局勢) heatmap: mission-by-mission progression patterns.
    """
    valid = game_df[game_df['局勢'].str.len() > 0].copy()
    if len(valid) == 0:
        return

    # Build a mission progression matrix
    round_cols = ['第一局', '第二局', '第三局', '第四局', '第五局']
    outcomes = ['三紅', '三藍死', '三藍活']

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    for oidx, outcome in enumerate(outcomes):
        ax = axes[oidx]
        subset = valid[valid['outcome'] == outcome]
        if len(subset) == 0:
            ax.set_title(f'{outcome} (n=0)')
            continue

        # Count round wins: how many rounds blue/red won
        round_data = []
        for _, row in subset.iterrows():
            round_seq = []
            for rc in round_cols:
                val = row[rc]
                if val == '藍':
                    round_seq.append(1)  # blue win
                elif val == '紅':
                    round_seq.append(0)  # red win
                else:
                    round_seq.append(np.nan)
            round_data.append(round_seq)

        round_arr = np.array(round_data, dtype=float)
        # Calculate blue win rate at each mission position
        blue_rates = np.nanmean(round_arr, axis=0) * 100

        bar_colors_r = ['#3498db' if b > 50 else '#e74c3c' for b in blue_rates]
        bars_r = ax.bar(range(5), blue_rates, color=bar_colors_r, alpha=0.8)
        ax.set_xticks(range(5))
        ax.set_xticklabels(['M1', 'M2', 'M3', 'M4', 'M5'])
        ax.set_ylabel('Blue Win Rate %')
        ax.set_title(f'{outcome} (n={len(subset)})')
        ax.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
        ax.set_ylim(0, 100)
        for bar, val in zip(bars_r, blue_rates):
            if not np.isnan(val):
                ax.text(bar.get_x() + bar.get_width()/2, val + 2, f'{val:.0f}%',
                       ha='center', fontsize=9)

    plt.suptitle('局勢分析: 各結局的任務藍方勝率\n(Mission Blue Win Rate by Game Outcome)', size=13, y=1.05)
    plt.tight_layout()
    if save:
        fig.savefig(OUTPUT_DIR / 'game_state_heatmap.png', dpi=150, bbox_inches='tight')
        print(f"[OK] Saved: {OUTPUT_DIR / 'game_state_heatmap.png'}")
    plt.close(fig)


def generate_summary_stats(df: pd.DataFrame) -> str:
    """Generate a text summary of key statistics."""
    data = filter_significant_players(df)
    all_data = df

    lines = []
    lines.append("=" * 60)
    lines.append("  AVALON DATA ANALYSIS SUMMARY")
    lines.append("  阿瓦隆百科 統計摘要")
    lines.append("=" * 60)
    lines.append("")

    # Overall stats
    lines.append(f"Total players in dataset: {len(all_data)}")
    lines.append(f"Players with {MIN_GAMES_THRESHOLD}+ games: {len(data)}")
    total_games_est = all_data['total_games'].max()
    lines.append(f"Most games by single player: {total_games_est:.0f}")
    lines.append("")

    # Top players
    lines.append("--- TOP 10 BY WIN RATE (50+ games) ---")
    top_wr = data.nlargest(10, 'win_rate')
    for _, row in top_wr.iterrows():
        lines.append(f"  {row['player']:12s}  {row['win_rate']:5.1f}%  ({row['total_games']:.0f} games)")
    lines.append("")

    # Best by role
    lines.append("--- BEST BY ROLE (10+ role games, 50+ total) ---")
    for role in ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣']:
        role_data = data[data[f'raw_{role}'] >= 10]
        if len(role_data) > 0:
            best = role_data.nlargest(1, f'wr_{role}').iloc[0]
            lines.append(f"  {role}: {best['player']:12s}  {best[f'wr_{role}']:5.1f}%  ({best[f'raw_{role}']:.0f} games as {role})")
    lines.append("")

    # Seat analysis
    lines.append("--- SEAT POSITION INSIGHTS ---")
    seat_avgs = {}
    for s in ['1','2','3','4','5','6','7','8','9','0']:
        col = f'seat{s}_wr'
        avg = data[col].mean()
        seat_avgs[s] = avg
    best_seat = max(seat_avgs, key=seat_avgs.get)
    worst_seat = min(seat_avgs, key=seat_avgs.get)
    lines.append(f"  Best avg seat: Seat {best_seat} ({seat_avgs[best_seat]:.1f}%)")
    lines.append(f"  Worst avg seat: Seat {worst_seat} ({seat_avgs[worst_seat]:.1f}%)")
    lines.append("")

    # Merlin dynamics
    lines.append("--- MERLIN DYNAMICS ---")
    lines.append(f"  Avg Merlin kill rate (red side): {data['red_merlin_dead'].mean():.1f}%")
    lines.append(f"  Avg Merlin survive rate (blue side): {data['blue_merlin_alive'].mean():.1f}%")
    best_killer = data.nlargest(1, 'red_merlin_dead').iloc[0]
    best_protector = data.nlargest(1, 'blue_merlin_alive').iloc[0]
    lines.append(f"  Best Merlin killer: {best_killer['player']} ({best_killer['red_merlin_dead']:.1f}%)")
    lines.append(f"  Best Merlin protector: {best_protector['player']} ({best_protector['blue_merlin_alive']:.1f}%)")
    lines.append("")

    # Red vs Blue balance
    lines.append("--- FACTION BALANCE ---")
    avg_red_rate = data['red_role_rate'].mean()
    lines.append(f"  Avg red role assignment rate: {avg_red_rate:.1f}%")
    lines.append(f"  Avg blue role assignment rate: {100 - avg_red_rate:.1f}%")

    return "\n".join(lines)


# =============================================================================
# 4. MAIN EXECUTION
# =============================================================================

def generate_per_game_summary(game_df: pd.DataFrame, lake_results: dict, r11_results: dict, r12_results: dict) -> str:
    """Generate summary text for per-game analyses."""
    lines = []
    lines.append("")
    lines.append("=" * 60)
    lines.append("  PER-GAME ANALYSIS RESULTS")
    lines.append("  (from Google Sheets: 牌譜)")
    lines.append("=" * 60)
    lines.append(f"\nTotal games analyzed: {len(game_df)}")
    lines.append(f"Games with outcome: {game_df['outcome'].notna().sum()}")
    lines.append(f"  三紅 (Red win): {(game_df['outcome'] == '三紅').sum()}")
    lines.append(f"  三藍死 (Blue win, Merlin killed): {(game_df['outcome'] == '三藍死').sum()}")
    lines.append(f"  三藍活 (Blue win, Merlin survived): {(game_df['outcome'] == '三藍活').sum()}")

    # Lady of the Lake summary
    lines.append("\n--- LADY OF THE LAKE ---")
    if lake_results:
        for lake_label in ['首湖', '二湖', '三湖']:
            if lake_label in lake_results:
                stats = lake_results[lake_label]
                overall_rwr = stats['combo_stats']['red_wins'].sum() / stats['combo_stats']['total'].sum() * 100
                lines.append(f"  {lake_label} ({stats['total_games']} games, overall Red WR: {overall_rwr:.1f}%):")
                for _, row in stats['combo_stats'].iterrows():
                    if int(row['total']) < 3:
                        continue  # skip sparse combos
                    lines.append(f"    {row.iloc[0]}>{row.iloc[1]}: Red WR {row['red_wr']:.1f}% (n={int(row['total'])})")
        if 'holder_role_stats' in lake_results:
            lines.append("  Lake 1 Holder Role:")
            for _, row in lake_results['holder_role_stats'].sort_values('red_wr', ascending=False).iterrows():
                lines.append(f"    {row.iloc[0]}: Red WR {row['red_wr']:.1f}% (n={int(row['total'])})")
        if 'target_role_stats' in lake_results:
            lines.append("  Lake 1 Target Role:")
            for _, row in lake_results['target_role_stats'].sort_values('red_wr', ascending=False).iterrows():
                if not row.iloc[0] or int(row['total']) < 3:
                    continue
                lines.append(f"    {row.iloc[0]}: Red WR {row['red_wr']:.1f}% (n={int(row['total'])})")

    # Round 1-1 summary
    lines.append("\n--- ROUND 1-1 VISION ANALYSIS ---")
    if r11_results and 'vision_stats' in r11_results:
        vs = r11_results['vision_stats']
        lines.append(f"  Merlin in 1-1 team: M1 pass {vs['merlin_in_team']['mission1_pass_rate']:.1f}% ({vs['merlin_in_team']['games']} games)")
        lines.append(f"  Merlin NOT in 1-1 team: M1 pass {vs['merlin_not_in_team']['mission1_pass_rate']:.1f}% ({vs['merlin_not_in_team']['games']} games)")
        lines.append(f"  Percival in 1-1 team: M1 pass {vs['percival_in_team']['mission1_pass_rate']:.1f}% ({vs['percival_in_team']['games']} games)")

    # Round 1-1 red count
    if r11_results and 'red_in_r11' in r11_results:
        lines.append("\n--- RED IN 1-1 TEAM ---")
        for _, row in r11_results['red_in_r11'].iterrows():
            lines.append(f"  {int(row['r11_red_count'])} red in team: M1 pass {row['mission1_pass_rate']:.1f}%, Red WR {row['overall_red_wr']:.1f}% (n={int(row['games'])})")

    # Round 1-2 branching
    lines.append("\n--- MISSION BRANCHING ---")
    if r12_results and 'mission1_branch' in r12_results:
        for _, row in r12_results['mission1_branch'].iterrows():
            status = 'PASS' if row['mission1_passed'] else 'FAIL'
            lines.append(f"  M1 {status}: Red WR {row['red_wr']:.1f}%, Merlin Kill {row['merlin_kill_rate']:.1f}% (n={int(row['games'])})")

    return "\n".join(lines)


def main():
    print("Loading data...")
    df = load_raw_data(RAW_DATA_PATH)
    print(f"Loaded {len(df)} players from aggregate stats")
    print(f"Top player: {df.iloc[0]['player']} with {df.iloc[0]['total_games']:.0f} games")
    print()

    # Connect to Google Sheets
    print("Connecting to Google Sheets...")
    sh = connect_sheets()
    print("[OK] Connected to Sheets")

    print("Loading game log (牌譜)...")
    game_df = load_game_log(sh)
    print(f"[OK] Loaded {len(game_df)} games from 牌譜")

    print("Loading chemistry matrices...")
    matrices = load_chemistry_matrices(sh)
    print(f"[OK] Loaded {len(matrices)} matrices: {list(matrices.keys())}")
    print()

    # =========================================================================
    # AGGREGATE STATS ANALYSES
    # =========================================================================
    summary = generate_summary_stats(df)
    print(summary)

    print("\n--- Generating Aggregate Visualizations ---")

    print("\n[1/9] Player radar chart...")
    plot_player_radar(df)

    print("[2/9] Seat position heatmap...")
    plot_seat_heatmap(df)

    print("[3/9] Red/Blue seat heatmap...")
    plot_seat_heatmap_red_blue(df)

    print("[4/9] Role aptitude rankings...")
    plot_role_aptitude(df)

    print("[5/9] Faction performance...")
    plot_faction_performance(df)

    print("[6/9] Experience trend...")
    plot_win_rate_trend(df)

    print("[7/9] Role distribution...")
    plot_role_distribution_comparison(df)

    print("[8/9] Three-red analysis...")
    plot_three_red_analysis(df)

    print("[9/9] Chemistry matrix (actual co-occurrence data)...")
    plot_chemistry_matrix(df, matrices=matrices)

    # Appearance vs reality analysis
    print("\n--- Appearance vs Reality Analysis ---")
    appearance = analyze_appearance_vs_reality(df)
    if appearance:
        print(f"  Analyzed {len(appearance)} players")
        best_red = max(appearance.items(), key=lambda x: x[1]['red_wr'])
        print(f"  Best red player: {best_red[0]} (red WR: {best_red[1]['red_wr']:.1f}%)")

    # =========================================================================
    # PER-GAME ANALYSES (Google Sheets data)
    # =========================================================================
    print("\n" + "=" * 60)
    print("  PER-GAME ANALYSES (Google Sheets)")
    print("=" * 60)

    # Analysis 1: Lady of the Lake
    print("\n[G1] Lady of the Lake (湖中女神)...")
    lake_results = analyze_lady_of_lake(game_df)
    plot_lady_of_lake(lake_results)

    # Analysis 2-3: Round 1-1
    print("[G2] Round 1-1 analysis (vision/Merlin thumb)...")
    r11_results = analyze_round_11(game_df)
    plot_round_11_analysis(r11_results)

    # Analysis 4: Round 1-2 branching
    print("[G3] Round 1-2 branching...")
    r12_results = analyze_round_12_branching(game_df)
    plot_round_12_branching(r12_results)

    # Analysis 5: Full chemistry matrix
    print("[G4] Detailed chemistry matrices...")
    plot_chemistry_detailed(matrices)

    # Analysis 6: Mission vote vs ball
    print("[G5] Mission vote analysis...")
    plot_mission_vote_analysis(game_df)

    # Game state heatmap
    print("[G6] Game state heatmap...")
    plot_game_state_heatmap(game_df)

    # =========================================================================
    # COMBINED SUMMARY
    # =========================================================================
    per_game_summary = generate_per_game_summary(game_df, lake_results, r11_results, r12_results)
    full_summary = summary + "\n" + per_game_summary

    summary_path = OUTPUT_DIR / 'summary.txt'
    summary_path.write_text(full_summary, encoding='utf-8')
    print(f"\n[OK] Saved: {summary_path}")

    print("\n" + "=" * 60)
    print("  ANALYSIS COMPLETE")
    print(f"  Output directory: {OUTPUT_DIR}")
    print(f"  Aggregate charts: 9")
    print(f"  Per-game charts: 6")
    print(f"  Total games analyzed: {len(game_df)}")
    print("=" * 60)


if __name__ == '__main__':
    main()
