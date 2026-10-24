"""Import all ORM models so Alembic sees their metadata."""

from .base import Base
from .chat import ChatConversation, ChatMessage
from .checks import ChangeEvent, CheckResult, CheckRun, CreditLedger
from .intelligence import AISummary, Alert, AlertRule, Recommendation, ReviewInsight
from .product import Competitor, Pincode, Product, ProductListing, ProductPincode
from .telegram import TelegramLink, TelegramLinkAttempt, TelegramLinkCode
from .user import Subscription, User, UserSettings

__all__ = [
    "AISummary",
    "Alert",
    "AlertRule",
    "Base",
    "ChangeEvent",
    "ChatConversation",
    "ChatMessage",
    "CheckResult",
    "CheckRun",
    "Competitor",
    "CreditLedger",
    "Pincode",
    "Product",
    "ProductListing",
    "ProductPincode",
    "Recommendation",
    "ReviewInsight",
    "Subscription",
    "TelegramLink",
    "TelegramLinkAttempt",
    "TelegramLinkCode",
    "User",
    "UserSettings",
]
