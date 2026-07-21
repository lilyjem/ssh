// 输出字符上限，避免返回过大内容
export const CHARACTER_LIMIT = 25000;
// 命令输入最大长度，避免滥用或意外超长
export const COMMAND_MAX_CHARS = 1000;
// SSH keepalive 默认间隔（毫秒），防止空闲连接被防火墙/NAT 断开
export const DEFAULT_KEEPALIVE_INTERVAL = 10000;
// keepalive 最大无响应次数，超过后判定连接死亡
export const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
// 自动重连最大尝试次数
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
// 重连基础延迟（毫秒）
export const DEFAULT_RECONNECT_BASE_DELAY = 1000;
// 重连最大延迟（毫秒）
export const DEFAULT_RECONNECT_MAX_DELAY = 10000;
