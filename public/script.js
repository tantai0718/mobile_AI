// Tạo session ID duy nhất cho mỗi phiên
const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

// Biến toàn cục để quản lý trạng thái phân trang và lọc sản phẩm
let currentPage = 1;
let totalPages = 1;
let currentBrand = '';

// Hàm định dạng giá theo chuẩn Việt Nam
function formatPrice(price) {
    const numericPrice = typeof price === 'string' ? parseFloat(price) : price;
    const roundedPrice = Math.round(numericPrice);
    return roundedPrice.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' VNĐ';
}

// Hàm lấy lời chào theo thời gian thực
function getGreetingByTime() {
    const currentHour = new Date().getHours();
    if (currentHour >= 5 && currentHour < 11) return "Chào buổi sáng";
    if (currentHour >= 11 && currentHour < 14) return "Chào buổi trưa";
    if (currentHour >= 14 && currentHour < 18) return "Chào buổi chiều";
    return "Chào buổi tối";
}

// Toggle khung chat (hiển thị/ẩn khung chat)
function toggleChatbot() {
    const chatbotContainer = document.getElementById('chatbotContainer');
    chatbotContainer.style.display = chatbotContainer.style.display === 'flex' ? 'none' : 'flex';
}

// Hiển thị tin nhắn trong khung chat
function displayMessage(message, sender, imageUrl = null, showButtons = false, products = null) {
    const messagesContainer = document.getElementById('chatbotMessages');
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);

    if (typeof DOMPurify !== 'undefined') {
        messageElement.innerHTML = DOMPurify.sanitize(message);
    } else {
        messageElement.textContent = message;
    }

    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (sender === 'bot') {
        attachChooseButtons(); // Gán sự kiện "Chọn mẫu này" sau mỗi tin bot
    }
}

// Gửi tin nhắn từ người dùng đến server
async function sendMessage() {
    const userInput = document.getElementById('userInput');
    const message = userInput.value.trim();
    if (!message) return;

    displayMessage(message, 'user');
    userInput.value = '';

    try {
        const response = await fetch('/chatbot', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Session-Id': sessionId
            },
            body: JSON.stringify({ message })
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        displayMessage(data._text, 'bot', data.imageUrl, data.showButtons, data.products);
    } catch (error) {
        console.error("❌ Lỗi gửi tin nhắn:", error);
        displayMessage("❌ Lỗi khi gửi tin nhắn. Vui lòng thử lại sau.", 'bot');
    }
}

// Gắn sự kiện click cho các nút "Chọn mẫu này"
function attachChooseButtons() {
    const buttons = document.querySelectorAll('.buy-btn');
    buttons.forEach(button => {
        button.onclick = async () => {
            const productName = button.dataset.productName;

            if (!productName) {
                displayMessage("⚠️ Không thể xác định sản phẩm. Vui lòng thử lại sau.", 'bot');
                return;
            }

            const message = productName;

            displayMessage(message, 'user');

            try {
                const response = await fetch('/chatbot', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Session-Id': sessionId
                    },
                    body: JSON.stringify({ message })
                });

                const data = await response.json();
                displayMessage(data._text, 'bot', data.imageUrl, data.showButtons, data.products);
            } catch (err) {
                console.error('❌ Lỗi khi gửi thông tin sản phẩm:', err);
                displayMessage("❌ Không thể kết nối tới chatbot.", 'bot');
            }
        };
    });
}

// Tải danh sách sản phẩm từ API
async function loadProducts() {
    const search = document.getElementById('searchInput').value;
    const minPrice = document.getElementById('minPrice').value || 0;
    const maxPrice = document.getElementById('maxPrice').value || Infinity;

    try {
        const response = await fetch(`/products?page=${currentPage}&limit=12&search=${search}&minPrice=${minPrice}&maxPrice=${maxPrice}${currentBrand ? `&brand=${currentBrand}` : ''}`);
        const data = await response.json();
        const productGrid = document.getElementById('productGrid');
        productGrid.innerHTML = '';

        data.products.forEach(product => {
            const displayPrice = product.formattedPrice || formatPrice(product.price);
            productGrid.innerHTML += `
                <div class="product-card">
                    <img src="/images/${product.image_url}" alt="${product.name}" class="product-image">
                    <div class="product-info">
                        <h3>${product.name}</h3>
                        <p>${displayPrice}</p>
                    <button class="buy-btn" data-product-name="${product.name}">Chọn mẫu này</button>

                    </div>
                </div>
            `;
        });

        attachChooseButtons(); // Gán lại sự kiện sau khi render xong

        // Phân trang
        currentPage = data.page;
        totalPages = Math.ceil(data.total / data.limit);
        document.getElementById('pageInfo').textContent = `Trang ${currentPage}/${totalPages}`;
        document.getElementById('prevPage').disabled = currentPage === 1;
        document.getElementById('nextPage').disabled = currentPage === totalPages;
    } catch (error) {
        console.error("❌ Lỗi tải sản phẩm:", error);
        document.getElementById('productGrid').innerHTML = '<p>❌ Lỗi khi tải sản phẩm.</p>';
    }
}

// Sự kiện tìm kiếm
function searchProducts() {
    currentPage = 1;
    loadProducts();
}

// Chuyển trang
function changePage(direction) {
    const newPage = currentPage + direction;
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        loadProducts();
    }
}

// Lọc theo thương hiệu
document.querySelectorAll('.nav-categories a').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        currentBrand = link.dataset.brand;
        currentPage = 1;
        loadProducts();
    });
});

// Gửi tin nhắn khi nhấn Enter
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('userInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/2.4.0/purify.min.js';
    document.head.appendChild(script);

    const greeting = getGreetingByTime();
    displayMessage(`${greeting}!`, 'bot');

    setTimeout(() => {
        displayMessage("Chào mừng đến với shop điện thoại của chúng tôi! Tôi có thể giúp gì cho bạn?", 'bot');
    }, 1000);

    loadProducts();
});
