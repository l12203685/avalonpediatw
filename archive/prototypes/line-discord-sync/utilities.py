# -*- coding: utf-8 -*-
"""This python file will handle some extra functions."""
import datetime
import json
import os
import random
import subprocess
import sys
import time

import requests
import yaml
from moviepy.video.io.VideoFileClip import VideoFileClip
from pydub import AudioSegment
from yaml import SafeLoader

import pandas as pd
import re

try:
    folder_path = os.path.dirname(__file__)
except:
    folder_path = os.path.join(os.path.expanduser('~'), 'GoogleDrive', 'GitHub', 'avalonpediatw-analysis')
print(f'folder_path: {folder_path}')

avalonpedia_gs_id = '13Mm_sZYQ9EOjrKd-NGLoIr_0B_t_KEMsb9tQEbU5oWE'

def get_full_file_path(file_name):
    current_file_path = os.path.abspath(__file__)
    return os.path.join(os.path.dirname(current_file_path), file_name)
    
path_config_yml = get_full_file_path('config.yml')
path_sync_channels_json = get_full_file_path('sync_channels.json')
path_binding_code_json = get_full_file_path('binding_code.json')

def config_file_generator():
    """Generate the template of config file"""
    with open(path_config_yml, 'w', encoding="utf8") as f:
        f.write("""# ++--------------------------------++
# | Discord-Line-Message-Sync v0.2.1 |
# | Made by LD (MIT License)         |
# ++--------------------------------++

# Bot Owner
# Fill in your name so others can know who is hosting the bot
# This will be shown when someone types /about
bot_owner: ''

# Paste your endpoint for the webhook here.
# You can use ngrok to get a free static endpoint now!
# Find out more here: https://ngrok.com/
webhook_url: ''

# Bot tokens and secrets
# You will need to fill in the tokens and secrets for your Line, Line Notify and Discord bots
# Line bot: https://developers.line.biz/console/
# Line Notify: https://notify-bot.line.me/my/services/
# Discord bot: https://discord.com/developers/applications/
Line_bot:
  channel_access_token: ''
  channel_secret: ''
Line_notify:
  client_id: ''
  client_secret: ''
Discord_bot:
  bot_token: ''


# (Optional settings)
# You can fill in your own bot invite link here
# This will be shown when someone types /about
# Noted that if you share your bot invite link, anyone can invite your bot to their server
line_bot_invite_link: ''
discord_bot_invite_link: ''

"""
                )
    sys.exit()

def read_config():
    """Read config file.

    Check if config file exists, if not, create one.
    if exists, read config file and return config with dict type.

    :rtype: dict
    """
    if not os.path.exists(path_config_yml):
        print("Config file not found, create one by default.\nPlease finish filling config.yml")
        with open(path_config_yml, 'w', encoding="utf8"):
            config_file_generator()

    try:
        with open(path_config_yml, 'r', encoding="utf8") as f:
            data = yaml.load(f, Loader=SafeLoader)
            config = {
                'bot_owner': data['bot_owner'],
                'webhook_url': data['webhook_url'],
                'line_channel_secret': data['Line_bot']['channel_secret'],
                'line_channel_access_token': data['Line_bot']['channel_access_token'],
                'line_notify_id': data['Line_notify']['client_id'],
                'line_notify_secret': data['Line_notify']['client_secret'],
                'discord_bot_token': data['Discord_bot']['bot_token']
            }
            if data['line_bot_invite_link']:
                config['line_bot_invite_link'] = data['line_bot_invite_link']
            if data['discord_bot_invite_link']:
                config['discord_bot_invite_link'] = data['discord_bot_invite_link']
            return config
    except (KeyError, TypeError):
        print(
            "An error occurred while reading config.yml, please check if the file is correctly filled.\n"
            "Check out the latest release to see if there is any update.\n"
            "If the problem can't be solved, consider delete config.yml and restart the program.\n")
        sys.exit()


def get_subscribed_discord_channels():
    """Get subscribed discord channels.

    :return list: Subscribed discord channels.
    """
    if not os.path.exists(path_sync_channels_json):
        print("sync_channels.json not found, create one by default.")
        with open(path_sync_channels_json, 'w', encoding="utf8") as file:
            json.dump([], file, indent=4)
            file.close()
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    subscribed_discord_channels = [int(entry['discord_channel_id']) for entry in data]
    return subscribed_discord_channels


def get_subscribed_line_channels():
    if not os.path.exists(path_sync_channels_json):
        print("sync_channels.json not found, create one by default.")
        with open(path_sync_channels_json, 'w', encoding="utf8") as file:
            json.dump([], file, indent=4)
            file.close()
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    subscribed_line_channels = [entry['line_group_id'] for entry in data]
    return subscribed_line_channels


def get_subscribed_info_by_discord_channel_id(discord_channel_id):
    """Get subscribed info by discord channel id.

    :param int discord_channel_id: Discord channel id.
    :return dict: Subscribed info. Include line_group_id, line_notify_token, discord_channel_id,
    discord_channel_webhook and sub_num.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    for index, entry in enumerate(data):
        if entry['discord_channel_id'] == discord_channel_id:
            subscribed_info = entry.copy()
            return subscribed_info
    return {}


def get_subscribed_info_by_line_group_id(line_group_id):
    """Get subscribed info by line group id.

    :param str line_group_id: Line group id.
    :return dict: Subscribed info. Include line_group_id, line_notify_token, discord_channel_id,
    discord_channel_webhook and sub_num.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    for index, entry in enumerate(data):
        if entry['line_group_id'] == line_group_id:
            subscribed_info = entry.copy()
            return subscribed_info
    return {}


def get_subscribed_info_by_sub_num(sub_num):
    """Get subscribed info by sub num.

    :param int sub_num: Subscribed sync channels num.
    :return dict: Subscribed info. Include line_group_id, line_notify_token, discord_channel_id,
    discord_channel_webhook and sub_num.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    for index, entry in enumerate(data):
        if entry['sub_num'] == sub_num:
            subscribed_info = entry.copy()
            return subscribed_info
    return {}


def add_new_sync_channel(line_group_id, line_group_name, line_notify_token, discord_channel_id, discord_channel_name, discord_channel_webhook):
    """Add new sync channel.

    :param str line_group_id: Line group id.
    :param str line_group_name: Line group name.
    :param str line_notify_token: Line notify token.
    :param int discord_channel_id: Discord channel id.
    :param str discord_channel_name: Discord channel name.
    :param str discord_channel_webhook: Discord channel webhook.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    if not data:
        sub_num = 1
    else:
        max_dict = max(data, key=lambda x: x.get('sub_num', 0))
        sub_num = max_dict.get('sub_num', 0) + 1
    folder_name = f'{line_group_name}_{discord_channel_name}'
    data.append({
        'sub_num': sub_num,
        'folder_name': folder_name,
        'line_group_id': line_group_id,
        'line_group_name': line_group_name,
        'line_notify_token': line_notify_token,
        'discord_channel_id': discord_channel_id,
        'discord_channel_name': discord_channel_name,
        'discord_channel_webhook': discord_channel_webhook
    })
    update_json(path_sync_channels_json, data)


def remove_sync_channel_by_discord_channel_id(discord_channel_id):
    """Remove sync channel by discord channel id.

    :param int discord_channel_id: Discord channel id.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    for index, entry in enumerate(data):
        if entry['discord_channel_id'] == discord_channel_id:
            data.pop(index)
            update_json(path_sync_channels_json, data)


def get_discord_webhook_bot_ids():
    """Get discord webhook bot ids.

    :return list: Discord webhook bot ids.
    """
    data = json.load(open(path_sync_channels_json, 'r', encoding="utf8"))
    discord_channel_webhooks = [entry['discord_channel_webhook'] for entry in data]
    discord_webhook_bot_ids = [int(webhook.split('/')[-2]) for webhook in discord_channel_webhooks]
    return discord_webhook_bot_ids


def download_file_from_url(folder_name, url, filename):
    """Download file from url.

    Use to download any files from discord.

    :param str folder_name: Folder name of downloaded files.
    :param url: url of file
    :param filename: filename of file
    :return str: file path
    """
    r = requests.get(url, allow_redirects=True, timeout=5)
    path = get_full_file_path(f'/downloads/{folder_name}')
    if not os.path.exists(path):
        os.makedirs(path)
    file_path = f'{path}/{datetime.datetime.now().strftime("%Y%m%d%H%M%S%f")}_{filename}'
    with open(file_path, 'wb') as fd:
        fd.write(r.content)
    return file_path


def download_file_from_line(folder_name, source, message_type):
    """Get file binary and save them in PC.

    Use to download files from LINE.

    :param str folder_name: Folder name of downloaded files.
    :param source: source of file that given by LINE
    :param message_type: message type from line
    :return str: file path
    """
    file_type = {
        'image': 'jpg',
        'video': 'mp4',
        'audio': 'm4a',
    }
    path = get_full_file_path(f'/downloads/{folder_name}')
    if not os.path.exists(path):
        os.makedirs(path)
    file_path = f'{path}/{datetime.datetime.now().strftime("%Y%m%d%H%M%S%f")}.{file_type.get(message_type)}'
    with open(file_path, 'wb') as fd:
        for chunk in source.iter_content():
            fd.write(chunk)
    return file_path


def generate_thumbnail(video_path, thumbnail_path=None, time=1):
    """Generate thumbnail from video.

    According to LINE API, when sending video, thumbnail is required.

    :param str video_path: Video path.
    :param str thumbnail_path: Thumbnail path. If not given, will use video path to generate.
    :param int time: Frame of video to generate thumbnail.(in seconds), default is 1.
    :return str: Thumbnail path.
    """
    if thumbnail_path is None:
        thumbnail_path = f'{os.path.splitext(video_path)[0]}.jpg'
    video = VideoFileClip(video_path)
    video.save_frame(thumbnail_path, t=time)
    return thumbnail_path


def convert_audio_to_m4a(audio_path, result_path=None):
    """Convert audio file to m4a format.

    According to LINE API, audio file must be m4a format.
    You must install ffmpeg to use this function.
    Support: mp3, wav, aac, flac, ogg, opus format.

    :param str audio_path: Audio path.
    :param result_path: Result path. If not given, will use audio path to generate.
    :return str: Audio path.
    """
    if result_path is None:
        result_path = f'{os.path.splitext(audio_path)[0]}.m4a'
    subprocess.run(
        f'ffmpeg -i {audio_path} -c:a aac -vn {result_path} -hide_banner -loglevel error')
    return result_path


def get_audio_duration(audio_path, file_format='m4a'):
    """Get audio duration.

    You must install ffmpeg to use this function.

    :param str audio_path: Audio path.
    :param str file_format: Audio file format. Default is m4a.
    :return int duration: Audio duration in milliseconds.
    """
    audio = AudioSegment.from_file(audio_path, format=file_format)
    duration = audio.duration_seconds * 1000
    return duration


def generate_binding_code(line_group_id, line_group_name, line_notify_token):
    """Generate binding code.

    :param str line_group_id: Line group id.
    :param str line_group_name: Line group name.
    :param str line_notify_token: Line notify token.
    :return str: Binding code.
    """
    if not os.path.exists(path_binding_code_json):
        with open(path_binding_code_json, 'w', encoding="utf8") as file:
            json.dump({}, file, indent=4)
            file.close()
    data = json.load(open(path_binding_code_json, 'r', encoding="utf8"))
    binding_code = str(random.randint(100000, 999999))
    data[binding_code] = {'line_group_id': line_group_id, 'line_group_name': line_group_name, 'line_notify_token': line_notify_token, 'expiration': time.time() + 300}
    update_json(path_binding_code_json, data)
    return binding_code


def remove_binding_code(binding_code):
    """Remove binding code from binding_codes.json.

    :param str binding_code: Binding code.
    """
    data = json.load(open(path_binding_code_json, 'r', encoding="utf8"))
    if binding_code in data:
        data.pop(binding_code)
        update_json(path_binding_code_json, data)


def get_binding_code_info(binding_code):
    """Get binding code info.

    :param str binding_code: Binding code.
    :return dict: Binding code info. Include line_group_id, line_notify_token and expiration.
    """
    data = json.load(open(path_binding_code_json, 'r', encoding="utf8"))
    if binding_code in data:
        return data[binding_code]
    return {}


def update_json(file, data):
    """Update a json file.

    :param str file: The file to update.
    :param dict data: The data to update.
    """
    with open(file, 'w', encoding="utf8") as file:
        json.dump(data, file, indent=4, ensure_ascii=False)
        file.close()

def get_gs(gs_id=avalonpedia_gs_id):
    import gspread
    from oauth2client.service_account import ServiceAccountCredentials
    scope = ['https://spreadsheets.google.com/feeds',
             'https://www.googleapis.com/auth/drive']
        
    credentials = ServiceAccountCredentials.from_json_keyfile_name(
        os.path.join(folder_path, 'avalonpediatw-gs-api-credentials.json'), 
        scope
        )
    
    gc = gspread.authorize(credentials)
    gs = gc.open_by_key(gs_id)
    return gs
  
def get_gs_pygs():
    import pygsheets
    gc = pygsheets.authorize(service_file=os.path.join(folder_path, 'avalonpediatw-gs-api-credentials.json'))

def get_clean_record():
    gs = get_gs()
    ws = gs.worksheet('牌譜')
    data = ws.get_all_values()
    df = pd.DataFrame(data[1:], columns=data[0])
    df['文字記錄'] = df['文字記錄'].str.lower()
    df['日期時間'] = pd.to_datetime(df['日期時間'])
    for i in range(10):
        df[f'玩{(i + 1) % 10}'] = df[f'玩{(i + 1) % 10}'].str.upper()
    df = df.rename({
        '日期時間': 'datetime', 
        })
    df = df[df["流水號"] != ""]
    return df

def mission_result_crawrler(text):
    lines = text.replace('\r', '\n').split('\n')
    lines = [line for line in lines]
    # re.findall(r'ooo|oox|oxx|xxx|oooo|ooox|ooxx|oxxx|xxxx|ooooo|oooox|oooxx|ooxxx|oxxxx', text)
    filtered_lines = [line for line in lines if re.match('^[ox]+$', line)]  # 使用正则表达式匹配每一行是否符合条件
    # return '\n'.join(filtered_lines) if filtered_lines else ''
    return filtered_lines

def upload_data(data, sheetname='data'):
    df = data.copy()
    gs = get_gs()
    ws = gs.worksheet(sheetname)
    ws.clear()  # 清空工作表
    ws.append_rows([df.columns.tolist()] + df.values.tolist())

def data_calc(cnt_thred=30):
    df = get_clean_record();
    r_team = ['刺', '娜', '德', '奧']
    b_team = ['派', '梅', '忠']
    char_list = r_team + b_team
    result_list = ['三紅', '三藍死', '三藍活']
    df['配置'] = df['配置'].apply(lambda x: {char_list[i]: x[i] for i in range(len(char_list) - 1)})
    
    mission_result = pd.DataFrame({
        i: df['文字記錄']
        .apply(mission_result_crawrler)
        .apply(lambda x: '' if len(x) < i + 1 else x[i])
        .apply(lambda r: {s: r.count(s) for s in ['o', 'x']})
        .apply(lambda r: '紅' if r['x'] > (1 if i == 3 else 0) else '藍')
        for i in range(5)
        })

    df['結果'] = (
        mission_result.sum(axis=1)
        .apply(lambda r: {s: r.count(s) for s in ['藍', '紅']})
        .apply(lambda r: '三紅' if r['紅'] >= 3 else '三藍')
        + (df['配置'].apply(lambda x: x['梅']) == df['刺殺']
           ).apply(lambda x: '死' if x else '活')
        ).apply(lambda x: x[:2] if x[:2] == '三紅' else x)

    for i in range(10):
        df[f'角{(i + 1) % 10}'] = df['配置'].apply(
            lambda x: {v: k for k, v in x.items()}[str((i + 1) % 10)] 
            if str((i + 1) % 10) in x.values() else '忠'
            )
        df[f'陣{(i + 1) % 10}'] = df[f'角{(i + 1) % 10}'].apply(
            lambda x: 1 if x in ['派', '梅', '忠'] else -1
            )
   
    player_records = pd.Series(''.join([
        df[f'玩{(i + 1) % 10}'].apply(lambda x: x + ', ').sum() 
        for i in range(10)
        ]).split(', '))
    player_list = list(player_records.unique())

    player_count = pd.Series({
        player: player_records.to_list().count(player) 
        for player in player_list
        }).rename('count').sort_values(ascending=False).iloc[1:]
    
    game_result_noplay = (df['結果'] * pd.DataFrame({
        player: pd.concat([df[f'玩{(i + 1) % 10}'] == player for i in range(10)], axis=1).sum(axis=1) == 0
        for player in player_count[player_count > cnt_thred * 2].index
        }).T).apply(lambda x: x.value_counts(), axis=1)[result_list]

    game_result_noplay = (game_result_noplay.T/game_result_noplay.sum(axis=1)).T    
    
    except_game = pd.DataFrame({
        player: pd.DataFrame({
            i: (df[f'玩{(i + 1) % 10}'] == player).astype(int) 
            for i in range(10)
            }).sum(axis=1)
        for player in player_count[player_count < cnt_thred].index
        }).sum(axis=1) > 0
    
    # df_calc = df[~except_game].copy()
    # df_except = df[except_game].copy()
    # df_except['category'] = '娛樂'
    # try:
    #     df = pd.concat([df_calc, df_except])
    # except:
    #     df = df_calc.copy()
    # del df_calc, df_except, except_game

    for player in player_count[player_count < cnt_thred].index:
        for i in range(10):
            df[f'玩{(i + 1) % 10}'] = df[f'玩{(i + 1) % 10}'].replace(player, f'{int(cnt_thred)}場以下')

    df_stat = pd.DataFrame({
        (i + 1) % 10: 
            df.groupby(['日期時間', '結果', f'角{(i + 1) % 10}', f'玩{(i + 1) % 10}', '分類', 'note'])['流水號'].count()
        for i in range(10)
        }).stack().rename('count')
    df_stat = df_stat.reset_index()
    df_stat.columns = ['datetime', 'result', 'char', 'player', 'category', 'note', 'position', 'count']
    df_stat = df_stat[['count', 'player', 'result', 'char', 'position', 'datetime', 'category', 'note']]
    df_stat['datetime'] = df_stat['datetime'].apply(lambda x: x.strftime('%Y-%m-%d'))

    df_stat['winloss'] = (
        (df_stat['char'].isin(r_team) & df_stat['result'].isin(['三紅', '三藍死']))
        | (df_stat['char'].isin(b_team) & df_stat['result'].isin(['三藍活']))
        ).astype(int) * df_stat['count']

    avg_wr = pd.Series({
        'wr_theo': df_stat['winloss'].sum()/df_stat['count'].sum(),
        'wr_red': (df_stat.groupby('char')['winloss'].sum()/df_stat.groupby('char')['count'].sum())['刺'],
        'wr_blue': (df_stat.groupby('char')['winloss'].sum()/df_stat.groupby('char')['count'].sum())['梅'],
        })
    
    player_rank = pd.Series(df_stat.groupby('player')['count'].sum()[df_stat.groupby('player')['count'].sum() >= 50].index)
    player_wr = (
        df_stat.groupby(['player', 'char'])['winloss'].sum()
        /df_stat.groupby(['player', 'char'])['count'].sum()
        ).unstack().iloc[1:]
    wr_weight = pd.Series({'刺': 1, '娜': 1, '德': 1, '奧': 1, '派': 1, '梅': 1, '忠': 4})
    
    player_wr_t = (player_wr * wr_weight).sum(axis=1)/wr_weight.sum()
    w_list = list(player_wr_t.loc[player_rank.iloc[1:]][player_wr_t.loc[player_rank.iloc[1:]] >= avg_wr['wr_theo'] + player_wr_t.loc[player_rank.iloc[1:]].std()/4].index)
    l_list = list(player_wr_t.loc[player_rank.iloc[1:]][player_wr_t.loc[player_rank.iloc[1:]] <= avg_wr['wr_theo'] - player_wr_t.loc[player_rank.iloc[1:]].std()/4].index)
    n_list = list(pd.Series(player_list)[~pd.Series(player_list).isin(player_rank)].drop_duplicates()) + [' ']
    
    for i in range(10):
        df[f'w{(i + 1) % 10}'] = df[f'玩{(i + 1) % 10}'].apply(lambda x: 1 if x in w_list else 0)
        df[f'l{(i + 1) % 10}'] = df[f'玩{(i + 1) % 10}'].apply(lambda x: 1 if x in l_list else 0)
        df[f'n{(i + 1) % 10}'] = df[f'玩{(i + 1) % 10}'].apply(lambda x: 1 if x in n_list else 0)
    
    df[[
        'wt_cnt', 'wt_w_cnt',
        'lt_cnt', 'lt_w_cnt',
        'nt_cnt', 'nt_w_cnt',
        'xw_cnt', 'xw_w_cnt',
        'xl_cnt', 'xl_w_cnt',
        'xn_cnt', 'xn_w_cnt',
        ]] = pd.Series({
        i: pd.DataFrame({
            'wt_cnt': df[f'w{(i + 1) % 10}'],
            'wt_w_cnt': (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'w{(i + 1) % 10}'],
            'lt_cnt': df[f'l{(i + 1) % 10}'],
            'lt_w_cnt': (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'l{(i + 1) % 10}'],
            'nt_cnt': df[f'n{(i + 1) % 10}'],
            'nt_w_cnt': (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'n{(i + 1) % 10}'],
            'xw_cnt': df[f'l{(i + 1) % 10}'] +  df[f'n{(i + 1) % 10}'],
            'xw_w_cnt': (
                (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'l{(i + 1) % 10}']
                + (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'n{(i + 1) % 10}']
                ),
            'xl_cnt': df[f'w{(i + 1) % 10}'] +  df[f'n{(i + 1) % 10}'],
            'xl_w_cnt': (
                (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'w{(i + 1) % 10}']
                + (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'n{(i + 1) % 10}']
                ),
            'xn_cnt': df[f'w{(i + 1) % 10}'] +  df[f'l{(i + 1) % 10}'],
            'xn_w_cnt': (
                (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'w{(i + 1) % 10}']
                + (df[f'陣{(i + 1) % 10}'] * df['結果'].apply(lambda x: 1 if x == '三藍活' else -1)) * df[f'l{(i + 1) % 10}']
                ), 
            })
        for i in range(10)
        }).sum()
    return df

def update_stat(cnt_thred=30):
    df = data_calc(cnt_thred);
    df_stat = pd.DataFrame({
        (i + 1) % 10: 
            df.groupby([
                '日期時間', '結果', f'角{(i + 1) % 10}', f'玩{(i + 1) % 10}', '分類', 'note', 
                'wt_cnt', 'wt_w_cnt',
                'lt_cnt', 'lt_w_cnt',
                'nt_cnt', 'nt_w_cnt',
                'xw_cnt', 'xw_w_cnt',
                'xl_cnt', 'xl_w_cnt',
                'xn_cnt', 'xn_w_cnt',
                ])['流水號'].count().rename('count')
        for i in range(10)
        }).stack().rename('count')
    df_stat = df_stat.reset_index()
    df_stat.columns = [
        'datetime', 'result', 'char', 'player', 'category', 'note', 
        'wt_cnt', 'wt_w_cnt',
        'lt_cnt', 'lt_w_cnt',
        'nt_cnt', 'nt_w_cnt',
        'xw_cnt', 'xw_w_cnt',
        'xl_cnt', 'xl_w_cnt',
        'xn_cnt', 'xn_w_cnt',
        'position', 'count',
        ]
    df_stat = df_stat[[
        'count', 'player', 'result', 'char', 'position', 'datetime', 'category', 'note',
        'wt_cnt', 'wt_w_cnt',
        'lt_cnt', 'lt_w_cnt',
        'nt_cnt', 'nt_w_cnt',
        'xw_cnt', 'xw_w_cnt',
        'xl_cnt', 'xl_w_cnt',
        'xn_cnt', 'xn_w_cnt',
        ]]
    df_stat['datetime'] = df_stat['datetime'].apply(lambda x: x.strftime('%Y-%m-%d'))
    
    upload_data(df_stat)
    return print('upload done.')
    
def help_message():
    suffixes = [
        '功能說明',
        '目前可用指令: [view = obs, fish, perc, ans, kill, {p}send{n}, lake{n}, mission{n}, sim]',
        '請輸入以 "/" 為起始的指令, 若為模擬瓦上帝請輸入 "/sim" 為起始的指令,',
        '並在指令後加上 "#場次流水號"',
        '也可以在場次流水號部分輸入 "rand", 即可隨機抽取牌局。',
        '',
        '[基礎指令]',
        '`/view#87` - 旁觀視角 (所有人至少派過一次派票 + 兩次任務結果 + 第一次湖中)。',
        '`/perc#87` - 派西維爾視角',
        '`/fish#87` - 隨機忠臣視角',
        '`/kill#87` - 刺殺階段資訊',
        '`/view#rand` - 旁觀視角撈出隨機牌局',
        '',
        '[進階指令]',
        '`/{p}send{n}#87` - {p} 玩家在第 87 號牌局中的第 {n} 次派票前資訊。',
        '`/lake{n}#87` - 第 {n} 次湖中前的資訊。',
        '`/mission{n}#87` - 第 {n} 次尾派任務的資訊。 (mission1 = 1-5, mission2 = 2-5, ...)',
        '`/ans#94` - 撈出第 94 號牌局，並輸出全部的人設與配置。',
        '`/sim#123` - 撈出第 123 號模擬牌局，並輸出全部的人設與配置。',
        '`/sim#rand` - 撈出隨機模擬牌局，並輸出全部的人設與配置。',
        '',
        '有疑問或建議歡迎加入阿瓦隆百科群組詢問: https://linktr.ee/avalonpediatw'
    ]
    return "\n".join(suffixes)

def get_reply_message(message):
    reply_message = "指令錯誤或功能尚未開發，請輸入 /help 查看指令清單。"
    
    if message.startswith('/'):
        match = re.match(r"/([\w-]+)#?(\d+|rand)?", message)
        if match:
            order, row = match.groups()
            order = order.lower()
            ws_name = "牌譜" 
            if order.startswith("sim"):
                ws_name = "模擬瓦"

            if order == "help":
                return help_message()

            if order == "update":
                cnt_thred = 30
                update_stat(cnt_thred)
                return f'戰績表已更新, 生涯門檻值:{cnt_thred}場'

            if order == "皓":
                return "皓子加班辛苦, 但還是缺少截圖, 科科 :D \n 歡迎加入阿瓦隆百科: https://linktr.ee/avalonpediatw"

            if order == "joy":
                return "JOY少咬一點玻璃, 不要再被沒龜花騙ㄌ \n 歡迎加入阿瓦隆百科: https://linktr.ee/avalonpediatw"
        
            try:
                data = get_data(row, ws_name)
                mode = order
                n = None
                player = None
                if order not in ['ans', 'view', 'obs', 'perc', 'fish', 'kill']:
                    n = order[-1]
                    mode = order[:-1]
                if 'send' in order:
                    player = order[0]
                    mode = 'send'
                return get_game_info(data, mode, n, player)

            except ValueError:
                return (
                f"請輸入有效指令: \n"
                + help_message()
                )
            except Exception as e:
                return f"發生錯誤：{e}"

    return reply_message
    
    
def get_data(row, ws_name="牌譜"):

    gs = get_gs()
    ws = gs.worksheet(ws_name)
    max_row = len(ws.get_all_values())  
    if not row or str(row).lower() == "rand":
        row = random.randint(2, max_row)  
    else: 
        row = int(row)
        if row < 2 or row > max_row:
            print("輸入的場次編號超出範圍, 改成隨機抽取")
            row = random.randint(2, max_row)
    
    try:
        record = ws.cell(row, 2).value.replace('\r', '').replace('  ', ' ').lower()
        char = ws.cell(row, 3).value
        kill = ws.cell(row, 4).value  
        category = ws.cell(row, 5).value  
        date = ws.cell(row, 6).value 
        player_list = {
            player % 10: ws.cell(row, 9 + player).value
            for player in range(1, 11)
            }
        data = {
            'row': row,
            'record': record,
            'char': char,
            'kill': kill,
            'category': category,
            'date': date,
            'player_list': player_list
            }

        return data

    except ValueError:
        print("請輸入有效的場次編號, 改成隨機抽取")
        return get_data('rand')

    except Exception as e:
        print(f"發生錯誤：{e}, 改成隨機抽取")
        return get_data('rand')

def get_game_info(data, mode, n=None, player=None):
    """
    根據 mode 回傳對應的遊戲資訊：
    1. `send`: 玩家 player 第 n 次派票前的資訊
    2. `lake`: 第 n 次湖中前的資訊
    3. `mission`: 第 n 次尾派任務的資訊
    4. `view`: 旁觀視角 (所有人至少派過一次派票 + 兩次任務結果 + 第一次湖中)
    5. `perc`: 旁觀 + 派西維爾資訊
    6. `fish`: 旁觀 + 隨機其中一位忠臣資訊
    7. `kill`: 刺殺階段資訊（刺殺梅林）

    :param data: 遊戲紀錄 (dict)，包含 "record", "char", "kill", "category", "date", "player_list"
    :param mode: 查詢模式 ("send", "lake", "mission", "view", "perc", "fish", "kill")
    :param n: 第幾次 (int) - 針對 `send`, `lake`, `mission` 有效
    :param player: 玩家號碼 (int) - 針對 `send` 有效
    :return: 指定條件的遊戲資訊
    """

    row = data['row']
    record = data['record']
    char = data['char']
    kill = data['kill']
    category = data['category']
    date = data['date']
    player_list = data['player_list']
    
    roles = ["刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林"]
    
    char_list = {char[i]: roles[i] for i in range(len(char))}   
    for player in set(str(i) for i in range(10)) - set(char_list.keys()):
        char_list[player] = "忠臣"
    
    char_map = {roles[i]:char[i] for i in range(len(char))} 
        
    char_info = {
        char_map["刺客"]: sorted([char_map["莫甘娜"], char_map["莫德雷德"]]),
        char_map["莫甘娜"]: sorted([char_map["刺客"], char_map["莫德雷德"]]),
        char_map["莫德雷德"]: sorted([char_map["刺客"], char_map["莫甘娜"]]),
        char_map['梅林']: sorted([char_map["刺客"], char_map["莫甘娜"], char_map["奧伯倫"]]),
        char_map['派西維爾']: sorted([char_map["梅林"], char_map["莫甘娜"]]),
        }
    
    lines = record.split("\n")

    # 正則表達式模式
    mission_pattern = r"^(ooo|oox|oxx|xxx|oooo|ooox|ooxx|oxxx|xxxx|ooooo|oooox|oooxx|ooxxx|oxxxx)$"
    lake_pattern = r"\d>\d\s*[ox\?]*"

    res = {}
    player_count = 1
    send_count = 1
    lake_count = 1
    mission_count = 1

    for i, line in enumerate(lines):
        if not re.match(mission_pattern, line) and not re.match(lake_pattern, line):
            res[f'{player_count % 10}send{send_count}'] = (i + 1, line)
            if player_count % 10 == 0:
                send_count += 1
            player_count += 1
            
        if re.match(lake_pattern, line):
            res[f'lake{lake_count}'] = (i + 1, line)
            lake_count += 1

        if re.match(mission_pattern, line):
            res[f'mission{mission_count}'] = (i + 1, line)
            mission_count += 1
    
    obs_line = max(res['0send1'][0], res['mission2'][0], res['lake1'][0])
    title = f"#{row}|{date}|{category}\n"

    try:
        if mode == "view" or mode == 'obs':
            return (
                title
                + f"{record[:sum(len(lines[i]) + 1 for i in range(obs_line))]}"
                + "--------------------------"
                + f"\n旁觀視角, "
                + "\n請找出自己以外四位好人"
                + "\n--------------------------"
                )

        if mode == "perc":
            player = char[4]
            return (
                title
                + f"{record[:sum(len(lines[i]) + 1 for i in range(obs_line))]}"
                + "--------------------------"
                + f"\n{player}家{char_list[player]}視角 "
                + (f"\n{char_info[player]} 是你看到的拇指 " if player in char_info.keys() else "")
                + "\n請找出自己以外四位好人"
                + "\n--------------------------"
                )
    
        if mode == "fish":
            player = str(random.choice(list(set('0123456789') - set(char))))
            return (
                title
                + f"{record[:sum(len(lines[i]) + 1 for i in range(obs_line))]}"
                + "--------------------------"
                + f"\n{player}家{char_list[player]}視角 "
                + "\n請找出自己以外三位好人"
                + "\n--------------------------"
                )
        
        if mode == "send":
            return (
                title
                + record[:sum(len(lines[i]) + 1 for i in range(res[f'{player}{mode}{n}'][0] - 1))]
                + "--------------------------"
                + f"\n{player}家{char_list[player]}視角 "
                + (f"\n{char_info[player]} 是你看到的拇指 " if player in char_info.keys() else "")
                + "\n請決定派票"
                + "\n--------------------------"
                )
    
        if mode == "lake":
            player = res[f'{mode}{n}'][1][0]
            return (
                title
                + record[:sum(len(lines[i]) + 1 for i in range(res[f'{mode}{n}'][0] - 1))]
                + "--------------------------"                
                + f"\n{player}家{char_list[player]}視角 "
                + (f"\n{char_info[player]} 是你看到的拇指 " if player in char_info.keys() else "")
                + "\n請決定湖中對象"
                + "\n--------------------------"                
                )
    
        if mode == "mission":
            player = next(((k, v) for k, v in res.items() if v[0] == res[f'{mode}{n}'][0] - 1), None)[0][0]
            # res[f'{mode}{n}'][1][0]
            return (
                title
                + record[:sum(len(lines[i]) + 1 for i in range(res[f'{mode}{n}'][0] - 2))]
                + "--------------------------"
                + f"\n{player}家{char_list[player]}視角 "
                + (f"\n{char_info[player]} 是你看到的拇指 " if player in char_info.keys() else "")
                + "\n請決定派票"
                + "\n--------------------------"
                )
    
        if mode == "kill":
            return (
                title
                + f"{record}"
                + "--------------------------"
                + f"刺娜德奧: {char[:4]}"
                + "--------------------------"
                + "刺殺階段請找出梅林"
                )
        
        if mode == "ans":
            player_print = ''.join([f"{str(num)}: {name}, " + ('\n' if num == 5 else '') for num, name in player_list.items()])
            ans = (
                title
                + f"{record}"
                + "\n--------------------------"
                + f"\n刺娜德奧: {char[:4]}"
                + "\n--------------------------"
                + f"\n{player_print}"
                + "\n--------------------------"
                + f"\n刺殺: {kill}"
                + f"\n刺娜德奧派梅: {char}"
                )
            return ans
        
    except:
        return get_game_info(data, 'obs')
