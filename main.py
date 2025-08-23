import os
import re
import asyncio
import logging
from datetime import datetime
from pathlib import Path
import fcntl
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from webdriver_manager.firefox import GeckoDriverManager
import threading
import json
import socketserver
import http.server

# إعداد التسجيل - تقليل الرسائل غير المهمة
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.WARNING
)
# تعطيل رسائل httpx و selenium
logging.getLogger('httpx').setLevel(logging.ERROR)
logging.getLogger('selenium').setLevel(logging.ERROR)
logging.getLogger('urllib3').setLevel(logging.ERROR)
logging.getLogger('telegram').setLevel(logging.ERROR)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# إعدادات البوت
BOT_TOKEN = '7496162273:AAG3AmOnpuGNXgM3hhZmJquJDGeszSBF5eo'
PORT = int(os.getenv('PORT', 8000))  # استخدام منفذ 8000 بدلاً من 5000

# إنشاء مجلد لقطات الشاشة
screenshots_dir = Path('screenshots')
screenshots_dir.mkdir(exist_ok=True)

class TelegramBot:
    def __init__(self):
        self.driver = None

    def setup_driver(self):
        """إعداد متصفح Firefox"""
        if not self.driver:
            firefox_options = Options()
            firefox_options.add_argument('--headless')
            firefox_options.add_argument('--no-sandbox')
            firefox_options.add_argument('--disable-dev-shm-usage')
            firefox_options.add_argument('--disable-gpu')
            firefox_options.add_argument('--window-size=375,667')
            firefox_options.add_argument('--disable-images')  # تعطيل تحميل الصور لتسريع التحميل
            firefox_options.add_argument('--disable-javascript')  # تعطيل JavaScript غير الضروري
            firefox_options.set_preference("general.useragent.override", 
                "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1")
            firefox_options.set_preference("dom.webdriver.enabled", False)
            firefox_options.set_preference("useAutomationExtension", False)
            firefox_options.set_preference("media.volume_scale", "0.0")
            firefox_options.set_preference("permissions.default.image", 2)  # حظر الصور
            firefox_options.set_preference("dom.ipc.plugins.enabled.libflashplayer.so", False)  # تعطيل Flash
            firefox_options.set_preference("media.autoplay.default", 0)  # منع التشغيل التلقائي

            service = Service(GeckoDriverManager().install())
            self.driver = webdriver.Firefox(service=service, options=firefox_options)
            self.driver.set_page_load_timeout(10)  # تحديد وقت انتظار أقصى لتحميل الصفحة
            logger.info("✅ Firefox browser setup successfully")

    async def take_screenshot(self, url):
        """أخذ لقطة شاشة من الموقع"""
        try:
            logger.info(f"Taking screenshot of: {url}")
            if not self.driver:
                self.setup_driver()
            self.driver.get(url)
            await asyncio.sleep(1)  # تقليل وقت الانتظار

            # التعامل مع النوافذ المنبثقة وأزرار الموافقة بشكل أسرع
            try:
                # البحث عن جميع الأزرار مرة واحدة
                all_buttons = self.driver.find_elements(By.XPATH, "//button | //a | //*[@role='button']")
                button_texts = []
                for btn in all_buttons[:10]:  # فحص أول 10 أزرار فقط
                    try:
                        text = btn.text.lower()
                        if text:
                            button_texts.append((btn, text))
                    except:
                        continue

                # النقر على الأزرار المطلوبة بسرعة
                for btn, text in button_texts:
                    if any(pattern in text for pattern in ['continue to web', 'accept all', 'accept', 'i agree', 'agree', "i'm ready to pump", 'ready to pump', "i'm ready"]):
                        try:
                            btn.click()
                            await asyncio.sleep(0.5)  # تقليل وقت الانتظار
                            break
                        except:
                            continue
            except Exception:
                pass

            # البحث عن Creator Rewards بشكل أسرع
            creator_rewards_amount = {'found': False}
            try:
                # البحث المباشر في النص المرئي بدلاً من page_source
                body_text = self.driver.find_element(By.TAG_NAME, "body").text.lower()
                money_pattern = re.compile(r'\$\d+\.\d{2}')
                money_matches = money_pattern.findall(body_text)
                
                if money_matches:
                    if 'creator rewards' in body_text or 'total' in body_text:
                        creator_rewards_amount = {
                            'found': True,
                            'amount': money_matches[0],
                            'position': 'Found near creator rewards and total'
                        }
                    else:
                        creator_rewards_amount = {
                            'found': True,
                            'amount': money_matches[0],
                            'position': 'Found dollar amount (fallback method)'
                        }
            except Exception:
                pass

            # أخذ لقطة الشاشة
            timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
            filename = f'screenshot-{timestamp}.png'
            filepath = screenshots_dir / filename
            self.driver.save_screenshot(str(filepath))
            logger.info(f"Screenshot saved: {filename}")
            return {'filename': filename, 'creatorRewards': creator_rewards_amount}

        except Exception as error:
            logger.error(f'Error taking screenshot: {error}')
            raise

    def cleanup(self):
        """تنظيف الموارد"""
        if self.driver:
            self.driver.quit()
            self.driver = None

# إنشاء البوت
bot_instance = TelegramBot()

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("مرحباً بك 🌹\n\nارسل عنوان محفظة SOL للفحص 🔍")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    help_text = """
📖 المساعدة:

🌐 أرسل رابط موقع مثل:
• https://pump.fun/coin/...
• google.com
• github.com

💰 أو أرسل عنوان محفظة مثل:
• HjY2bjjBtPjp1V5muestDxd6ZehpCFG5Dt4ABA9MyGSr

⚡ البوت سيقوم تلقائياً بـ:
1. فتح الموقع
2. النقر على "continue to web"
3. النقر على "accept all"
4. النقر على "I'm ready to pump"
5. البحث عن مبلغ creator rewards
6. أخذ لقطة شاشة وإرسالها لك

/start - البدء
/help - المساعدة
    """
    await update.message.reply_text(help_text)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    text = update.message.text
    if not text:
        return

    # البحث عن عناوين المحافظ والروابط
    wallet_pattern = re.compile(r'[1-9A-HJ-NP-Za-km-z]{32,44}')
    wallet_matches = wallet_pattern.findall(text)
    url_pattern = re.compile(r'https?://[^\s]+')
    url_matches = url_pattern.findall(text)

    addresses_to_process = []
    for wallet in wallet_matches:
        if 32 <= len(wallet) <= 44:
            addresses_to_process.append({
                'type': 'wallet',
                'original': wallet,
                'url': f'https://pump.fun/profile/{wallet}?tab=coins'
            })
    for url in url_matches:
        addresses_to_process.append({
            'type': 'url',
            'original': url,
            'url': url
        })

    if not addresses_to_process:
        await update.message.reply_text('❌ لم يتم العثور على عناوين محافظ أو روابط صحيحة في رسالتك')
        return

    processing_msg = None
    if len(addresses_to_process) > 1:
        processing_msg = await update.message.reply_text(
            f'🔍 تم العثور على {len(addresses_to_process)} عنوان/رابط\n⏳ جاري المعالجة...\nيرجى الانتظار قليلاً'
        )
    else:
        processing_msg = await update.message.reply_text('⏳ انتظر قليلاً جاري الفحص...')

    try:
        success_count = 0
        error_count = 0
        for i, item in enumerate(addresses_to_process):
            try:
                if len(addresses_to_process) > 1 and processing_msg:
                    await processing_msg.edit_text(
                        f'🔍 تم العثور على {len(addresses_to_process)} عنوان/رابط\n⏳ جاري معالجة {i + 1}/{len(addresses_to_process)}...\n\nالحالي: {"محفظة" if item["type"] == "wallet" else "رابط"}'
                    )

                result = await bot_instance.take_screenshot(item['url'])

                caption = ''
                if len(addresses_to_process) > 1:
                    caption += f'✅ فحص رقم {i + 1}/{len(addresses_to_process)}\n\n'
                if item['type'] == 'wallet':
                    caption += f'💰 المحفظة: {item["original"]}\n\n'
                else:
                    caption += f'🌐 الرابط: {item["original"]}\n\n'
                if result['creatorRewards']['found']:
                    caption += f'💰 Creator Rewards Total: {result["creatorRewards"]["amount"]}\n\n'
                else:
                    caption += '💰 Creator Rewards: غير متوفر\n\n'

                keyboard = [[InlineKeyboardButton("إنتقال 🔗", url=item['url'])]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                image_path = screenshots_dir / result['filename']
                with open(image_path, 'rb') as photo:
                    await context.bot.send_photo(
                        chat_id=chat_id,
                        photo=photo,
                        caption=caption,
                        reply_markup=reply_markup,
                        parse_mode='HTML'
                    )

                def delete_file():
                    try:
                        os.remove(image_path)
                    except Exception as e:
                        logger.info(f'Error deleting file: {e}')

                threading.Timer(60, delete_file).start()

                success_count += 1
                if i < len(addresses_to_process) - 1:
                    await asyncio.sleep(0.3)  # تقليل وقت الانتظار بين العناوين
            except Exception as error:
                logger.error(f'Error processing {item["original"]}: {error}')
                error_count += 1
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=f'❌ خطأ في معالجة {"المحفظة" if item["type"] == "wallet" else "الرابط"}: {item["original"]}\n\nالخطأ: {str(error)}'
                )

        if processing_msg:
            await processing_msg.delete()

        if len(addresses_to_process) > 1:
            await context.bot.send_message(
                chat_id=chat_id,
                text=f'📊 ملخص النتائج:\n\n✅ تم بنجاح: {success_count}\n❌ فشل: {error_count}\n📝 المجموع: {len(addresses_to_process)}'
            )

    except Exception as error:
        logger.error(f'Error processing requests: {error}')
        if processing_msg:
            try:
                await processing_msg.delete()
            except Exception:
                pass
        await context.bot.send_message(
            chat_id=chat_id,
            text=f'❌ حدث خطأ عام أثناء معالجة طلبك:\n{str(error)}'
        )

def setup_http_server():
    class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/health':
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                health_data = {
                    'status': 'ok',
                    'message': 'Telegram Bot is running',
                    'timestamp': datetime.now().isoformat()
                }
                self.wfile.write(json.dumps(health_data, ensure_ascii=False).encode('utf-8'))
            else:
                self.send_response(200)
                self.send_header('Content-type', 'text/html; charset=utf-8')
                self.end_headers()
                html = f'''
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🤖 Telegram Bot Status</title></head>
<body><h1>🤖 البوت يعمل بنجاح</h1><p>آخر فحص: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p></body>
</html>
                '''
                self.wfile.write(html.encode('utf-8'))

    def run_server():
        try:
            with socketserver.TCPServer(("0.0.0.0", PORT), MyHTTPRequestHandler) as httpd:
                logger.info(f"🌐 HTTP server running on port {PORT}")
                httpd.serve_forever()
        except Exception as e:
            logger.error(f"❌ Failed to start HTTP server: {e}")

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

async def main() -> None:
    # إزالة نظام القفل في PythonAnywhere لأنه غير متوافق
    if os.path.exists('bot.lock'):
        try:
            os.remove('bot.lock')
            logger.info("🗑️ Removed stale lock file")
        except:
            pass

    setup_http_server()
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info('🤖 Telegram Bot is running...')
    logger.info('Make sure to set TELEGRAM_BOT_TOKEN environment variable')

    # إضافة مهمة فحص دوري لحالة البوت
    async def health_check():
        while True:
            try:
                await asyncio.sleep(60)  # فحص كل دقيقة
                logger.info('💓 Bot health check - running normally')
            except Exception as e:
                logger.error(f'Health check failed: {e}')
                break

    try:
        await application.initialize()
        await application.start()
        await application.updater.start_polling()
        
        # تشغيل فحص الحالة في الخلفية
        health_task = asyncio.create_task(health_check())
        
        # انتظار إلى الأبد
        await asyncio.Event().wait()
        
    except Exception as e:
        logger.error(f"❌ Bot error: {e}")
        try:
            await application.stop()
            await application.shutdown()
        except:
            pass
        raise
    finally:
        # تنظيف الموارد
        bot_instance.cleanup()
        if os.path.exists('bot.lock'):
            try:
                os.remove('bot.lock')
            except:
                pass

if __name__ == '__main__':
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
        try:
            asyncio.run(main())
            break  # خروج من اللوب إذا نجح البوت
        except KeyboardInterrupt:
            logger.info('🛑 Shutting down...')
            bot_instance.cleanup()
            break
        except Exception as e:
            retry_count += 1
            logger.error(f'Error running bot (attempt {retry_count}/{max_retries}): {e}')
            bot_instance.cleanup()
            
            if retry_count < max_retries:
                logger.info(f'🔄 Retrying in 5 seconds... ({retry_count}/{max_retries})')
                import time
                time.sleep(5)
            else:
                logger.error('❌ Max retries reached. Bot failed to start.')
                break