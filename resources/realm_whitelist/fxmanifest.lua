fx_version 'cerulean'
game 'gta5'

author 'REALM CITY'
description 'يتحقق من تفعيل اللاعب عن طريق موقع REALM CITY قبل دخوله السيرفر'
version '1.0.0'

server_scripts {
    '@oxmysql/lib/MySQL.lua', -- إذا تستخدم oxmysql (الأكثر شيوعًا حاليًا)
    'config.lua',
    'server.lua'
}
