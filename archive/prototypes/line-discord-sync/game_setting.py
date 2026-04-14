def get_setting(player_number=10):
    servant_number = int(player_number / 2 + 1) - 2

    role_sit = pd.Series(
        choice(range(1, player_number + 1), player_number, False))
    role = pd.Series(
        ['梅林', '派西維爾', ] + \
        ['忠臣'] * servant_number + \
        ['莫德雷德'] * int(player_number >= 8) + \
        ['奧伯倫'] * int(player_number >= 10) + \
        ['刺客', '莫甘娜']
        )

    setting = pd.DataFrame({'role_sit': role_sit, 'role': role})
    red_information = setting[setting['role'].isin(
        ['莫德雷德', '刺客', '莫甘娜'])]['role_sit'].sort_values(
            ascending=True).apply(lambda x: x % 10).to_list()
    merlin_information = setting[setting['role'].isin(
        ['奧伯倫', '刺客', '莫甘娜'])]['role_sit'].sort_values(
            ascending=True).apply(lambda x: x % 10).to_list()
    percival_information = setting[setting['role'].isin(
        ['梅林', '莫甘娜'])]['role_sit'].sort_values(
            ascending=True).apply(lambda x: x % 10).to_list()

    information = {
        '莫德雷德': red_information,
        '刺客': red_information,
        '莫甘娜': red_information,
        '梅林': merlin_information,
        '派西維爾': percival_information,
        '忠臣': [],
        '奧伯倫': [],
    }
    information = pd.Series(information).reset_index()
    information.columns = ['role', 'information']
    setting = setting.merge(information, how='left',
                            on='role').sort_values('role_sit')
    setting['role_sit'] %= 10
    return setting.set_index('role_sit').to_dict()
