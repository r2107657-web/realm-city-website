-- ==========================================================
-- REALM CITY WHITELIST
-- يتحقق من معرف الديسكورد لكل لاعب يحاول الدخول، مقارنة
-- بجدول whitelist_applications اللي يعبيه موقع REALM CITY
--
-- يعتمد على مورد oxmysql (لازم يكون مثبت وشغّال بالسيرفر)
-- إذا تستخدم mysql-async بدل oxmysql، بدّل الاستعلام تحت لصيغته
-- ==========================================================

AddEventHandler('playerConnecting', function(name, setKickReason, deferrals)
    local src = source
    deferrals.defer()

    Wait(0)
    deferrals.update('^3[REALM CITY]^7 يتم التحقق من حالة تفعيلك...')

    -- نجيب معرف الديسكورد من identifiers اللاعب
    local discordId = nil
    for _, id in ipairs(GetPlayerIdentifiers(src)) do
        if string.find(id, 'discord:') then
            discordId = string.gsub(id, 'discord:', '')
        end
    end

    if not discordId then
        deferrals.done('^1[REALM CITY]^7 لازم يكون حساب الديسكورد مربوط بـFiveM عندك عشان تدخل السيرفر.')
        return
    end

    -- نستعلم عن حالة التفعيل
    exports.oxmysql:query(
        'SELECT status FROM ' .. Config.Table .. ' WHERE discord_id = ? AND status = "whitelisted" LIMIT 1',
        { discordId },
        function(result)
            if result and #result > 0 then
                if Config.Debug then
                    print(('[REALM CITY] اللاعب %s (discord:%s) مفعّل — تم السماح بالدخول'):format(name, discordId))
                end
                deferrals.done()
            else
                if Config.Debug then
                    print(('[REALM CITY] اللاعب %s (discord:%s) غير مفعّل — تم رفض الدخول'):format(name, discordId))
                end
                deferrals.done(Config.KickMessage)
            end
        end
    )
end)
